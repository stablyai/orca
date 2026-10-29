import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { forkProcess } from '@orca/process-host/fork-process'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadChildRequest
} from './worker-thread-child-process-protocol'

// Worker-thread half; must stay electron-free (plain-Node entry guard).
const OUTPUT_HIGH_WATER_BYTES = 256 * 1024

export type WorkerThreadChildPort = {
  on(event: 'message', listener: (request: WorkerThreadChildRequest) => void): unknown
  postMessage(event: WorkerThreadChildEvent, transferList?: ArrayBuffer[]): void
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
  const children = new Map<number, { child: ChildProcess; pendingOutputBytes: number }>()

  const spawnChild = (
    request: Extract<WorkerThreadChildRequest, { type: 'spawn' | 'fork' }>
  ): void => {
    const { id } = request
    let child: ChildProcess
    try {
      child =
        request.type === 'fork'
          ? forkProcess({
              ...request.spec,
              serialization: 'advanced',
              stdio: ['ignore', 'ignore', 'ignore', 'ipc']
            })
          : spawnProcess({ ...request.spec, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      port.postMessage({ type: 'spawn-error', id, error: toErrorPayload(error) })
      return
    }
    const state = { child, pendingOutputBytes: 0 }
    children.set(id, state)
    const postOutput = (type: 'stdout' | 'stderr', chunk: Buffer): void => {
      state.pendingOutputBytes += chunk.byteLength
      if (state.pendingOutputBytes >= OUTPUT_HIGH_WATER_BYTES) {
        child.stdout?.pause()
        child.stderr?.pause()
      }
      // Own the pipe chunk before transfer; a pooled Buffer may share its backing allocation.
      const bytes = new Uint8Array(chunk)
      port.postMessage({ type, id, chunk: bytes }, [bytes.buffer])
    }
    const postError = (error: Error): void =>
      port.postMessage({ type: 'error', id, error: toErrorPayload(error) })
    child.on('spawn', () => port.postMessage({ type: 'spawn', id, pid: child.pid }))
    child.on('message', (message: unknown) =>
      port.postMessage({ type: 'ipc-message', id, message })
    )
    child.on('disconnect', () => port.postMessage({ type: 'disconnect', id }))
    child.stdout?.on('data', (chunk: Buffer) => postOutput('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => postOutput('stderr', chunk))
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
    if (request.type === 'spawn' || request.type === 'fork') {
      spawnChild(request)
      return
    }
    const state = children.get(request.id)
    if (!state) {
      return
    }
    const { child } = state
    try {
      if (request.type === 'ipc-send') {
        child.send(request.message, (error: Error | null) => {
          port.postMessage({
            type: 'ipc-sent',
            id: request.id,
            sendId: request.sendId,
            ...(error ? { error: toErrorPayload(error) } : {})
          })
        })
      } else if (request.type === 'output-consumed') {
        state.pendingOutputBytes = Math.max(0, state.pendingOutputBytes - request.bytes)
        if (state.pendingOutputBytes < OUTPUT_HIGH_WATER_BYTES) {
          child.stdout?.resume()
          child.stderr?.resume()
        }
      } else if (request.type === 'stdin-write') {
        child.stdin?.write(request.data)
      } else if (request.type === 'stdin-end') {
        child.stdin?.end()
      } else {
        child.kill(request.signal)
      }
    } catch (error) {
      if (request.type === 'ipc-send') {
        port.postMessage({
          type: 'ipc-sent',
          id: request.id,
          sendId: request.sendId,
          error: toErrorPayload(error)
        })
      }
      // Races with exit; the exit/close events still reach the stand-in.
    }
  })
}
