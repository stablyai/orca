import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { spawnProcessOnWorkerThread } from '../../../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildProcess } from '../../../worker-thread-child-process/worker-thread-child-process'

type CaptureOptions = {
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
      env: options.env,
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
  const encoding = options.encoding === null ? 'buffer' : (options.encoding ?? 'utf8')
  if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) {
    throw new TypeError(`Unsupported output encoding: ${encoding}`)
  }
  const child = launch()
  const stdout = createOutputSink(options.maxBuffer)
  const stderr = createOutputSink(options.maxBuffer)
  const read = (): { stdout: string | Buffer; stderr: string | Buffer } => ({
    stdout: encoding === 'buffer' ? stdout.buffer() : stdout.buffer().toString(encoding),
    stderr: encoding === 'buffer' ? stderr.buffer() : stderr.buffer().toString(encoding)
  })
  options.onCapture?.(read)
  let completed = false
  let overflowError: Error | null = null
  const finish = (error: Error | null, captured?: ReturnType<typeof read>): void => {
    if (completed) {
      return
    }
    completed = true
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
  child.once('error', (error: Error) => {
    options.onError?.(error)
    finish(error)
  })
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    finish(
      overflowError ??
        (code === 0
          ? null
          : Object.assign(
              new Error(
                options.errorCommand
                  ? `Command failed: ${options.errorCommand}\n${stderr.text()}`
                  : stderr.text().trim() || `${command} exited with ${code}`
              ),
              {
                code,
                signal,
                killed: signal !== null,
                ...(options.errorCommand ? { cmd: options.errorCommand } : {})
              }
            ))
    )
  })
  return child
}
