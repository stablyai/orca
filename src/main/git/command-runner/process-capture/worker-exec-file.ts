import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hasLocalCommandSelection } from '../../../ipc/command-path/command-path-resolver'
import {
  childSpawnerIsIsolated,
  isWorkerChildStdinWriteError,
  spawnProcessOnWorkerThread,
  spawnWorkerReadyNow,
  whenSpawnWorkerReady,
  WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'

export type CaptureOptions = {
  cwd?: string | URL
  env?: NodeJS.ProcessEnv
  encoding?: string | null
  maxBuffer: number
  ownedPosixGroup?: boolean
  errorCommand?: string
  onOverflow?: (error: Error) => void
  onError?: (error: Error) => void
  onCapture?: (read: () => { stdout: string | Buffer; stderr: string | Buffer }) => void
}
type CaptureCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void

/** Process creation blocks its calling loop (fork/exec; CreateProcessW for seconds under endpoint security, #11161, #27362).
 * On POSIX, main keeps what only its launch does: canStart rechecked at creation, and a probed CLI selection run under its own name. */
export async function capturesOnWorker(
  command: string,
  options: { canStart?: () => boolean; spawnOnWorkerThread?: boolean }
): Promise<boolean> {
  if (process.platform === 'win32') {
    return options.spawnOnWorkerThread !== false && whenSpawnWorkerReady()
  }
  // Linux: the launcher keeps main's Chromium sockets out of Git, so Git waits for it rather than
  // starting on main; only a start gate, rechecked at creation, stays on main (through the helper).
  if (keepsMainFdsOut() && !options.canStart) {
    return options.spawnOnWorkerThread !== false && whenSpawnWorkerReady()
  }
  if (options.canStart || hasLocalCommandSelection(command)) {
    return false
  }
  // A booting worker would delay this result, so main spawns meanwhile unless the caller must stay off main.
  return options.spawnOnWorkerThread === true ? whenSpawnWorkerReady() : spawnWorkerReadyNow()
}

/** Linux with the launcher installed: Git kept on main still must not inherit main's Chromium sockets. */
export function keepsMainFdsOut(): boolean {
  return process.platform === 'linux' && childSpawnerIsIsolated()
}

/** Starts through the fd-closing helper, in its own group when the capture owns one. */
export function spawnWithoutMainFds(
  command: string,
  args: readonly string[],
  options: { cwd?: unknown; env?: NodeJS.ProcessEnv; detached?: boolean }
): ChildProcess {
  return spawnProcess({
    program: command,
    args: [...args],
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    detached: options.detached === true,
    stdio: ['pipe', 'pipe', 'pipe'],
    closeInheritedFds: true
  })
}

/** Main's error text per platform; a Windows overflow ends the whole tree, or a hook holding the pipe blocks close. */
export function withMainErrorText<O extends CaptureOptions>(
  options: O,
  command: string,
  args: readonly string[],
  stop: (error: Error) => void
): O {
  return {
    ...options,
    ...(process.platform !== 'darwin' ? { errorCommand: [command, ...args].join(' ') } : {}),
    ...(process.platform === 'win32' ? { onOverflow: stop } : {})
  }
}

/** A second, passive stderr listener: execFile still captures every byte. */
export function observeCapturedStderr(
  child: ChildProcess | WorkerThreadChildProcess,
  observer: (chunk: string) => void
): void {
  const onData = (chunk: string | Buffer): void => {
    try {
      observer(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    } catch (error) {
      // Detach throwing observers so stream callbacks cannot crash main.
      child.stderr?.off('data', onData)
      console.warn('git stderr observer failed; detaching it', error)
    }
  }
  child.stderr?.on('data', onData)
}

/** Capture a worker-owned child; the caller still owns deadlines and aborts. */
export function workerExecFile(
  command: string,
  args: string[],
  options: CaptureOptions,
  callback: CaptureCallback
): WorkerThreadChildProcess {
  return spawnedExecFile(command, options, callback, () =>
    spawnProcessOnWorkerThread({
      program: command,
      args,
      cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
      // The worker's env is a copy from its start; send main's current one (PATH refreshes after launch).
      env: options.env ?? process.env,
      ...(options.ownedPosixGroup ? { terminationBarrier: true as const } : {})
    })
  )
}

/** Capture either host's real child using the same byte limits and completion contract. */
export function spawnedExecFile<T extends ChildProcess | WorkerThreadChildProcess>(
  command: string,
  options: CaptureOptions,
  callback: CaptureCallback,
  launch: () => T
): T {
  const requested = options.encoding === null ? 'buffer' : (options.encoding ?? 'utf8')
  // Git asks for 'utf-8'; one spelling lets a failure reuse its decoded stderr.
  const encoding = requested.toLowerCase() === 'utf-8' ? 'utf8' : requested
  if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) {
    throw new TypeError(`Unsupported output encoding: ${encoding}`)
  }
  const child = launch()
  const stdout = createOutputSink(options.maxBuffer)
  const stderr = createOutputSink(options.maxBuffer)
  const decode = (bytes: Buffer): string | Buffer =>
    encoding === 'buffer' ? bytes : bytes.toString(encoding)
  const read = (): { stdout: string | Buffer; stderr: string | Buffer } => ({
    stdout: decode(stdout.buffer()),
    stderr: decode(stderr.buffer())
  })
  options.onCapture?.(read)
  let completed = false
  let overflowError: Error | null = null
  const finish = (error: Error | null, captured?: ReturnType<typeof read>): void => {
    if (completed) {
      return
    }
    completed = true
    // Output after completion has no reader; keep it on the worker while cleanup runs.
    if (child instanceof WorkerThreadChildProcess) {
      child.discardOutput()
    }
    const output = captured ?? read()
    callback(error, output.stdout, output.stderr)
  }
  const collect = (sink: typeof stdout, chunk: Buffer): void => {
    if (completed) {
      return
    }
    sink.write(chunk)
    if (sink.truncated() && !overflowError) {
      overflowError = Object.assign(new Error(`${command} output exceeded maxBuffer`), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true
      })
      if (options.onOverflow) {
        const output = read()
        Object.assign(overflowError, output)
        options.onOverflow(overflowError)
        finish(overflowError, output)
      } else {
        child.kill()
      }
    }
  }
  child.stdout?.on('error', () => {})
  child.stderr?.on('error', () => {})
  child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
  child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
  child.on('error', (error: Error) => {
    if (child instanceof WorkerThreadChildProcess && isWorkerChildStdinWriteError(error)) {
      return
    }
    options.onError?.(error)
    finish(error)
  })
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (completed) {
      return
    }
    if (overflowError || code === 0) {
      finish(overflowError)
      return
    }
    // Assemble stderr once; the failure message and the callback share it.
    const stderrBytes = stderr.buffer()
    const stderrText = stderrBytes.toString('utf8')
    const output = {
      stdout: decode(stdout.buffer()),
      stderr: encoding === 'utf8' ? stderrText : decode(stderrBytes)
    }
    finish(
      Object.assign(
        new Error(
          options.errorCommand
            ? `Command failed: ${options.errorCommand}\n${stderrText}`
            : stderrText.trim() || `${command} exited with ${code}`
        ),
        {
          code,
          signal,
          killed: signal !== null,
          ...(options.errorCommand ? { cmd: options.errorCommand } : {})
        }
      ),
      output
    )
  })
  return child
}
