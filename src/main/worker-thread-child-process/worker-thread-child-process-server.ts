import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadChildRequest
} from './worker-thread-child-process-protocol'

// Worker-thread half; must stay electron-free (plain-Node entry guard).

export type WorkerThreadChildPort = {
  on(event: 'message', listener: (request: WorkerThreadChildRequest) => void): unknown
  postMessage(event: WorkerThreadChildEvent): void
}

function toErrorPayload(error: unknown): WorkerThreadChildErrorPayload {
  if (error instanceof Error) {
    return 'code' in error && typeof error.code === 'string'
      ? { message: error.message, code: error.code }
      : { message: error.message }
  }
  return { message: String(error) }
}

export function serveWorkerThreadChildProcesses(port: WorkerThreadChildPort): void {
  const children = new Map<number, PipedChildProcess>()

  const spawnChild = ({ id, spec }: Extract<WorkerThreadChildRequest, { type: 'spawn' }>): void => {
    let child: PipedChildProcess
    try {
      child = spawnProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      port.postMessage({ type: 'spawn-error', id, error: toErrorPayload(error) })
      return
    }
    children.set(id, child)
    const postError = (error: Error): void =>
      port.postMessage({ type: 'error', id, error: toErrorPayload(error) })
    child.on('spawn', () => port.postMessage({ type: 'spawn', id, pid: child.pid }))
    // Copied so the clone carries only this chunk, not the whole backing allocation.
    child.stdout?.on('data', (chunk: Buffer) =>
      port.postMessage({ type: 'stdout', id, chunk: new Uint8Array(chunk) })
    )
    child.stderr?.on('data', (chunk: Buffer) =>
      port.postMessage({ type: 'stderr', id, chunk: new Uint8Array(chunk) })
    )
    // An unhandled stream error would take the whole worker, and every other child, down.
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    // The stand-in surfaces stdin failures as child errors; its caller treats both alike.
    child.stdin?.on('error', postError)
    child.on('error', postError)
    child.on('exit', (code, signal) => port.postMessage({ type: 'exit', id, code, signal }))
    child.on('close', (code, signal) => {
      children.delete(id)
      port.postMessage({ type: 'close', id, code, signal })
    })
  }

  port.on('message', (request) => {
    if (request.type === 'spawn') {
      spawnChild(request)
      return
    }
    const child = children.get(request.id)
    if (!child) {
      return
    }
    try {
      if (request.type === 'stdin-write') {
        child.stdin?.write(request.data)
      } else if (request.type === 'stdin-end') {
        child.stdin?.end()
      } else {
        child.kill(request.signal)
      }
    } catch {
      // Races with exit; the exit/close events still reach the stand-in.
    }
  })
}
