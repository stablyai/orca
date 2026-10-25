import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { fileURLToPath } from 'node:url'
import { spawnProcessOnWorkerThread } from '../../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildProcess } from '../../worker-thread-child-process/worker-thread-child-process'

/** Capture a worker-owned child; the caller still owns deadlines and aborts. */
export function workerExecFile(
  command: string,
  args: string[],
  options: {
    cwd?: string | URL
    env?: NodeJS.ProcessEnv
    encoding?: string | null
    maxBuffer: number
  },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
): WorkerThreadChildProcess {
  const encoding = options.encoding === null ? 'buffer' : (options.encoding ?? 'utf8')
  if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) {
    throw new TypeError(`Unsupported Git output encoding: ${encoding}`)
  }
  const child = spawnProcessOnWorkerThread({
    program: command,
    args,
    cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
    env: options.env
  })
  const stdout = createOutputSink(options.maxBuffer)
  const stderr = createOutputSink(options.maxBuffer)
  let completed = false
  const finish = (error: Error | null): void => {
    if (completed) {
      return
    }
    completed = true
    callback(
      error,
      encoding === 'buffer' ? stdout.buffer() : stdout.buffer().toString(encoding),
      encoding === 'buffer' ? stderr.buffer() : stderr.buffer().toString(encoding)
    )
  }
  const collect = (sink: typeof stdout, chunk: Buffer): void => {
    if (completed) {
      return
    }
    sink.write(chunk)
    if (sink.truncated()) {
      child.kill()
      finish(
        Object.assign(new Error('Git output exceeded maxBuffer'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          killed: true
        })
      )
    }
  }
  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
  child.once('error', finish)
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    finish(
      code === 0
        ? null
        : Object.assign(new Error(stderr.text().trim() || `${command} exited with ${code}`), {
            code,
            signal,
            killed: signal !== null
          })
    )
  })
  return child
}
