import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  nativeExecutableResolver,
  type NativeExecutableSelection
} from '@orca/process-host/native-executable-resolution'
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
      discarding?: { stdout?: boolean; stderr?: boolean }
    }
  >()

  const spawnChild = (
    { id, spec }: Extract<WorkerThreadChildRequest, { type: 'spawn' }>,
    selection: NativeExecutableSelection | undefined
  ): void => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] }, selection)
    } catch (error) {
      port.postMessage({ type: 'spawn-error', id, error: toErrorPayload(error) })
      return
    }
    // A failed creation has no pid and reports through 'error'; Node's own 'spawn' event would come a turn later.
    if (child.pid !== undefined) {
      port.postMessage({ type: 'spawn', id, pid: child.pid })
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
      if (state.discarding?.[type]) {
        return
      }
      state.pendingOutputBytes += chunk.byteLength
      if (state.pendingOutputBytes >= OUTPUT_HIGH_WATER_BYTES) {
        // A discarded stream keeps draining here; pausing it could fill the pipe and stall the child.
        if (!state.discarding?.stdout) {
          child.stdout?.pause()
        }
        if (!state.discarding?.stderr) {
          child.stderr?.pause()
        }
      }
      // Own the pipe chunk before transfer; a pooled Buffer may share its backing allocation.
      const bytes = new Uint8Array(chunk)
      port.postMessage({ type, id, chunk: bytes }, [bytes.buffer])
    }
    const postError = (error: Error): void =>
      port.postMessage({ type: 'error', id, error: toErrorPayload(error) })
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
      const retained = Boolean(state.group) && !state.groupTerminated
      if (!retained) {
        children.delete(id)
      }
      port.postMessage({ type: 'close', id, code, signal, ...(retained ? { retained: true } : {}) })
      if (state.stopping) {
        state.group?.close()
      }
    })
  }

  // Each launch waits a turn so cancels queued behind a slow CreateProcess can withdraw it first.
  type QueuedLaunch = {
    request: Extract<WorkerThreadChildRequest, { type: 'spawn' }>
    early: WorkerThreadChildRequest[]
    selection?: NativeExecutableSelection
  }
  const queued = new Map<number, QueuedLaunch>()
  // Launches whose PATH lookup settled, in that order; a withdrawn one is skipped when reached.
  const startable: QueuedLaunch[] = []
  let launching = false
  const launchNext = (): void => {
    let entry = startable.shift()
    while (entry && queued.get(entry.request.id) !== entry) {
      entry = startable.shift()
    }
    if (!entry) {
      launching = false
      return
    }
    queued.delete(entry.request.id)
    spawnChild(entry.request, entry.selection)
    for (const request of entry.early) {
      handle(request)
    }
    setImmediate(launchNext)
  }
  const makeStartable = (entry: QueuedLaunch): void => {
    startable.push(entry)
    if (!launching) {
      launching = true
      setImmediate(launchNext)
    }
  }

  const handle = (request: WorkerThreadChildRequest): void => {
    if (request.type === 'spawn') {
      const entry: QueuedLaunch = { request, early: [] }
      queued.set(request.id, entry)
      if (process.platform !== 'darwin') {
        makeStartable(entry)
        return
      }
      // macOS resolves PATH itself; each launch looks up async so a slow PATH directory blocks no other child.
      void nativeExecutableResolver
        .resolveAsync(request.spec.program, request.spec.env)
        .then(
          (selection) => {
            entry.selection = selection
          },
          () => {}
        )
        .then(() => {
          if (queued.get(request.id) === entry) {
            makeStartable(entry)
          }
        })
      return
    }
    const waiting = queued.get(request.id)
    // Any stop of a launch that has not started withdraws it; nothing is created only to be killed.
    if (
      waiting &&
      (request.type === 'cancel-spawn' ||
        request.type === 'kill' ||
        request.type === 'stop-owned-group')
    ) {
      queued.delete(request.id)
      const signal = (request.type === 'kill' && request.signal) || 'SIGTERM'
      // A group that was never created has ended, which an owned-group stop waits to hear.
      if (waiting.request.spec.terminationBarrier) {
        port.postMessage({ type: 'group-terminated', id: request.id })
      }
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
        if (request.stream) {
          state.discarding = { ...state.discarding, [request.stream]: true }
          child[request.stream]?.resume()
        } else {
          state.discarding = { stdout: true, stderr: true }
          state.pendingOutputBytes = 0
          child.stdout?.resume()
          child.stderr?.resume()
        }
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
