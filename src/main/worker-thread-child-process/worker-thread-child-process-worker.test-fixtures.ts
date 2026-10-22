import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { WorkerThreadChildProcessHost } from './worker-thread-child-process'
import type {
  WorkerThreadChildRequest,
  WorkerThreadChildSpec
} from './worker-thread-child-process-protocol'

export async function createWorkerThreadChildProcessTestEntry() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-worker-child-'))
  const entryPath = join(directory, 'worker-thread-child-process-entry.cjs')
  await build({
    entryPoints: [join(__dirname, 'worker-thread-child-process-entry.ts')],
    outfile: entryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  return { directory, entryPath, dispose: () => rm(directory, { recursive: true, force: true }) }
}

export function createWorkerThreadChildProcessTestHost(entryPath: string) {
  const worker = new Worker(entryPath)
  const transport = new EventEmitter()
  const acknowledgements: Extract<WorkerThreadChildRequest, { type: 'output-consumed' }>[] = []
  let holdingOutput = true
  let pendingBytes = 0
  let notifyBacklog: (() => void) | undefined
  const backlogged = new Promise<void>((resolve) => {
    notifyBacklog = resolve
  })
  worker.on('message', (event) => transport.emit('message', event))
  worker.on('error', (error) => transport.emit('error', error))
  worker.on('exit', (code) => transport.emit('exit', code))
  const host = new WorkerThreadChildProcessHost(() =>
    Object.assign(transport, {
      postMessage(request: WorkerThreadChildRequest): void {
        if (holdingOutput && request.type === 'output-consumed') {
          acknowledgements.push(request)
          pendingBytes += request.bytes
          if (pendingBytes >= 256 * 1024) {
            notifyBacklog?.()
          }
        } else {
          worker.postMessage(request)
        }
      },
      unref: () => worker.unref(),
      terminate: () => worker.terminate()
    })
  )
  const children: { kill: () => void; closed: Promise<void> }[] = []
  const releaseOutput = (): void => {
    holdingOutput = false
    for (const request of acknowledgements.splice(0)) {
      worker.postMessage(request)
    }
  }
  return {
    spawn(spec: WorkerThreadChildSpec) {
      const child = host.spawn(spec)
      let closed = false
      children.push({
        kill: () => {
          if (!closed) {
            child.kill('SIGKILL')
          }
        },
        closed: new Promise<void>((resolve) =>
          child.once('close', () => {
            closed = true
            resolve()
          })
        )
      })
      return child
    },
    backlogged,
    releaseOutput,
    async dispose(): Promise<void> {
      releaseOutput()
      for (const child of children) {
        child.kill()
      }
      await Promise.all(children.map((child) => child.closed))
      await worker.terminate()
    }
  }
}
