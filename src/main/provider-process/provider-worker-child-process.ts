import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { spawnProcess } from '@orca/process-host'
import type { ProviderProcessSpawner } from './provider-process-spawn'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import {
  isAbandonedWorkerChildError,
  type WorkerThreadChildProcess
} from '../worker-thread-child-process/worker-thread-child-process'
import {
  canSpawnOnProviderWorkerThread,
  spawnProcessOnProviderWorkerThread
} from './provider-worker-thread-host'

/** A worker child has three plain pipes and no POSIX group, IPC or verbatim command line. */
function workerSpawnable(spec: ProcessSpec): boolean {
  const extraStdio = Array.isArray(spec.stdio) && spec.stdio.length > 3
  return !extraStdio && !spec.detached && !spec.windowsVerbatimArguments && !spec.serialization
}

function outputDrained(stream: PassThrough): Promise<void> {
  if (stream.readableEnded || stream.destroyed) {
    return Promise.resolve()
  }
  // A stream nobody reads never ends; Node's own child discards unread output the same way.
  if (stream.readableFlowing === null) {
    stream.resume()
  }
  return new Promise((resolve) => {
    stream.once('end', resolve)
    stream.once('close', resolve)
  })
}

/** Node streams over a worker-owned child, so stream readers (readline, JSON-RPC) work unchanged. */
class ProviderWorkerChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  killed = false
  /** Settles once `pid` is known or the launch failed; awaitProviderChildSpawn waits on it. */
  readonly ready: Promise<void>
  private spawnFailed = false
  private outputEnded: Promise<void> | null = null

  constructor(private readonly worker: WorkerThreadChildProcess) {
    super()
    this.ready = new Promise((resolve) => {
      worker.once('spawn', () => resolve())
      worker.once('error', () => resolve())
      worker.once('close', () => resolve())
    })
    this.stdin = new Writable({
      decodeStrings: false,
      write: (chunk: Buffer | string, _encoding, callback) => {
        worker.stdin.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk))
        callback()
      },
      final: (callback) => {
        worker.stdin.end()
        callback()
      }
    })
    worker.stdout.on('data', (chunk: Buffer) => this.stdout.write(chunk))
    worker.stderr.on('data', (chunk: Buffer) => this.stderr.write(chunk))
    worker.on('spawn', () => this.emit('spawn'))
    worker.on('error', (error: Error) => this.fail(error))
    worker.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Like Node, a child that never started reports error and close, never exit.
      if (!this.spawnFailed) {
        this.emit('exit', code, signal)
      }
    })
    worker.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      void this.endOutput().then(() => this.emit('close', code, signal))
    })
  }

  get pid(): number | undefined {
    return this.worker.pid
  }

  get exitCode(): number | null {
    return this.worker.exitCode
  }

  get signalCode(): NodeJS.Signals | null {
    return this.worker.signalCode
  }

  kill(signal?: NodeJS.Signals): boolean {
    const sent = this.worker.kill(signal)
    this.killed ||= sent
    return sent
  }

  private fail(error: Error): void {
    this.spawnFailed ||= this.worker.pid === undefined
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    }
    // A lost worker took the pipes with it; end output so readers finish, but never infer exit.
    if (isAbandonedWorkerChildError(error)) {
      void this.endOutput()
    }
  }

  private endOutput(): Promise<void> {
    if (!this.outputEnded) {
      this.stdout.end()
      this.stderr.end()
      this.outputEnded = Promise.all([outputDrained(this.stdout), outputDrained(this.stderr)]).then(
        () => undefined
      )
    }
    return this.outputEnded
  }
}

function spawnOnProviderWorker(spec: ProcessSpec): ChildProcess {
  const worker = spawnProcessOnProviderWorkerThread({
    program: spec.program,
    args: [...(spec.args ?? [])],
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    // A worker's process.env is a copy taken at its start, so main always sends its own.
    env: spec.env ?? process.env
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provider consumers read only pid, ready, exitCode, signalCode, killed, kill, the child events and the three Node streams, all provided here; provider-worker-child-process.test.ts drives a real listing through it.
  return new ProviderWorkerChildProcess(worker) as unknown as ChildProcess
}

/** On Windows, process-host's own spawner creates agent processes on their process worker. */
export function resolveProviderSpawner(
  spawnImpl: ProviderProcessSpawner | undefined
): ProviderProcessSpawner | undefined {
  // Injected spawners are test or caller seams; only production's spawner is rerouted.
  const production = spawnImpl === undefined || spawnImpl === spawnProcess
  if (!production || process.platform !== 'win32') {
    return spawnImpl
  }
  // Checked per launch: a worker that could not start hands later launches back to main.
  return (spec) =>
    workerSpawnable(spec) && canSpawnOnProviderWorkerThread()
      ? spawnOnProviderWorker(spec)
      : spawnProcess(spec)
}
