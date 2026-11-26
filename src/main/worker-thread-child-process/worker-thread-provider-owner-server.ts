import { connect, type Socket } from 'node:net'
import { spawnProcess } from '@orca/process-host'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadProviderOwnerSpec
} from './worker-thread-child-process-protocol'

const CONNECT_TIMEOUT_MS = 5_000
const PROVIDER_PIPE_FDS = [1, 2, 3, 4, 5, 6, 7] as const

type ProviderOwnerPort = {
  postMessage(event: WorkerThreadChildEvent): void
}

function connectPipe(path: string, nonce: string, fd: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // The child shares this socket's description: an automatic end on EOF would shut it down there too.
    const socket = connect({ path, allowHalfOpen: true })
    const timer = setTimeout(
      () => fail(new Error('Provider owner connection timed out')),
      CONNECT_TIMEOUT_MS
    )
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      // The header precedes every byte the owner process writes, so the app reads it first.
      socket.write(`${nonce} ${fd}\n`, (error) => {
        if (error) {
          fail(error)
          return
        }
        clearTimeout(timer)
        socket.off('error', fail)
        socket.on('error', () => {})
        resolve(socket)
      })
    })
  })
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

/** Spawns orca-provider-exec on the worker thread so posix_spawn never blocks Electron's main thread. */
export async function spawnWorkerThreadProviderOwner(
  port: ProviderOwnerPort,
  id: number,
  spec: WorkerThreadProviderOwnerSpec
): Promise<void> {
  const pipes = await Promise.allSettled(
    PROVIDER_PIPE_FDS.map((fd) => connectPipe(spec.path, spec.nonce, fd))
  )
  const sockets = pipes.flatMap((pipe) => (pipe.status === 'fulfilled' ? [pipe.value] : []))
  try {
    if (sockets.length !== PROVIDER_PIPE_FDS.length) {
      throw new Error('Provider owner connection failed')
    }
    const child = spawnProcess({
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['ignore', ...sockets]
    })
    child.on('error', () => {})
    const pid = await new Promise<number | NodeJS.ErrnoException>((resolve) => {
      if (child.pid !== undefined) {
        resolve(child.pid)
        return
      }
      child.once('error', resolve)
    })
    if (typeof pid !== 'number') {
      port.postMessage({ type: 'provider-owner-error', id, error: toErrorPayload(pid) })
      return
    }
    // Keep the worker alive until this detached owner exits so libuv reaps it instead of leaving a zombie.
    child.once('exit', () => port.postMessage({ type: 'provider-owner-exit', id }))
    port.postMessage({ type: 'provider-owner-spawned', id, pid })
  } catch (error) {
    port.postMessage({ type: 'provider-owner-error', id, error: toErrorPayload(error) })
  } finally {
    // Close only this worker's descriptors (never end/shutdown); main's ProviderOwnerListener owns the pipes.
    for (const socket of sockets) {
      socket.destroy()
    }
  }
}
