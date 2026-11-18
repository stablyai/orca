import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createPosixGroupTermination } from '@orca/process-host/posix-group-termination'
import { spawnProcess } from '@orca/process-host'
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
  if (!(error instanceof Error)) {
    return { message: String(error) }
  }
  const { code, errno, syscall, path }: NodeJS.ErrnoException = error
  return {
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof errno === 'number' ? { errno } : {}),
    ...(typeof syscall === 'string' ? { syscall } : {}),
    ...(typeof path === 'string' ? { path } : {})
  }
}

export function serveWorkerThreadChildProcesses(port: WorkerThreadChildPort): void {
  const children = new Map<
    number,
    {
      child: ChildProcessWithoutNullStreams
      pendingOutputBytes: number
      group?: ReturnType<typeof createPosixGroupTermination>
      stopping: boolean
      closed: boolean
      groupTerminated: boolean
      discardingOutput?: boolean
    }
  >()

  const spawnChild = ({ id, spec }: Extract<WorkerThreadChildRequest, { type: 'spawn' }>): void => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      port.postMessage({ type: 'spawn-error', id, error: toErrorPayload(error) })
      return
    }
    const state: NonNullable<ReturnType<typeof children.get>> = {
      child,
      pendingOutputBytes: 0,
      stopping: false,
      closed: false,
      groupTerminated: false
    }
    if (spec.terminationBarrier && process.platform !== 'win32') {
      state.group = createPosixGroupTermination(child, () => {
        state.groupTerminated = true
        if (state.closed) {
          children.delete(id)
        }
        port.postMessage({ type: 'group-terminated', id })
      })
    }
    children.set(id, state)
    const postOutput = (type: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (state.discardingOutput) {
        return
      }
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
      state.closed = true
      if (!state.group || state.groupTerminated) {
        children.delete(id)
      }
      port.postMessage({ type: 'close', id, code, signal })
      if (state.stopping) {
        state.group?.close()
      }
    })
  }

  // Each launch waits a turn so cancels queued behind a slow CreateProcess can withdraw it first.
  const queued = new Map<
    number,
    {
      request: Extract<WorkerThreadChildRequest, { type: 'spawn' }>
      early: WorkerThreadChildRequest[]
    }
  >()
  let launching = false
  const launchNext = (): void => {
    const next = queued.values().next()
    if (next.done) {
      launching = false
      return
    }
    queued.delete(next.value.request.id)
    spawnChild(next.value.request)
    for (const request of next.value.early) {
      handle(request)
    }
    setImmediate(launchNext)
  }

  const handle = (request: WorkerThreadChildRequest): void => {
    if (request.type === 'spawn') {
      queued.set(request.id, { request, early: [] })
      if (!launching) {
        launching = true
        setImmediate(launchNext)
      }
      return
    }
    const waiting = queued.get(request.id)
    // Any stop of a launch that has not started withdraws it; nothing is created only to be killed.
    if (waiting && (request.type === 'cancel-spawn' || request.type === 'kill')) {
      queued.delete(request.id)
      const signal = (request.type === 'kill' && request.signal) || 'SIGTERM'
      port.postMessage({ type: 'exit', id: request.id, code: null, signal })
      port.postMessage({ type: 'close', id: request.id, code: null, signal })
      return
    }
    if (waiting) {
      waiting.early.push(request)
      return
    }
    const state = children.get(request.id)
    if (!state || request.type === 'cancel-spawn') {
      return
    }
    const { child } = state
    try {
      if (request.type === 'stop-owned-group') {
        if (state.group) {
          state.stopping = true
          void state.group.stop()
          if (state.closed) {
            state.group.close()
          }
        }
      } else if (request.type === 'release') {
        if (!state.stopping && state.closed) {
          children.delete(request.id)
        }
      } else if (request.type === 'output-consumed') {
        state.pendingOutputBytes = Math.max(0, state.pendingOutputBytes - request.bytes)
        if (state.pendingOutputBytes < OUTPUT_HIGH_WATER_BYTES) {
          child.stdout?.resume()
          child.stderr?.resume()
        }
      } else if (request.type === 'discard-output') {
        state.discardingOutput = true
        state.pendingOutputBytes = 0
        child.stdout?.resume()
        child.stderr?.resume()
      } else if (request.type === 'stdin-write') {
        child.stdin?.write(request.data)
      } else if (request.type === 'stdin-end') {
        child.stdin?.end()
      } else {
        child.kill(request.signal)
        if (child.exitCode !== null || child.signalCode !== null) {
          // Like execFile's kill: a descendant still holding an exited root's pipes must not keep close away.
          child.stdout?.destroy()
          child.stderr?.destroy()
        }
      }
    } catch {
      // Races with exit; the exit/close events still reach the stand-in.
    }
  }
  port.on('message', handle)
  port.postMessage({ type: 'ready' })
}
