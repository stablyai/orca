import type { PipedChildProcess } from '@orca/process-host/process-spec'
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'
import { createSshOperationAbortError } from '../ssh/ssh-connection-utils'
import { startWslCommandLoop, wslCommandLoopMarker, type WslCommandLoop } from './wsl-command-loop'

export type WslCommandLoopPool = {
  /** A channel on an idle loop, or null when the caller should start its own wsl.exe. */
  run(command: string, signal?: AbortSignal): Promise<RemoteCommandChannel | null>
  dispose(): void
}

type WslCommandLoopPoolOptions = {
  /** Starts `wsl.exe --exec sh -c <loop script> <argv0> <marker>`. */
  spawnLoop: (marker: string) => PipedChildProcess
  /** Concurrent commands beyond this run on their own wsl.exe, as before. */
  maxLoops?: number
  idleMs?: number
  /** A guest that cannot answer the self-test in time falls back to one wsl.exe per command. */
  readyTimeoutMs?: number
}

export function createWslCommandLoopPool(options: WslCommandLoopPoolOptions): WslCommandLoopPool {
  const maxLoops = options.maxLoops ?? 4
  const idleMs = options.idleMs ?? 5_000
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000
  const loops = new Set<WslCommandLoop>()
  const reserved = new Set<WslCommandLoop>()
  const idleTimers = new Map<WslCommandLoop, ReturnType<typeof setTimeout>>()
  // Sticky: a guest without mktemp/base64, or a wsl.exe that cannot keep a loop, stays direct.
  let unavailable = false
  let disposed = false

  const retire = (loop: WslCommandLoop): void => {
    clearTimeout(idleTimers.get(loop))
    idleTimers.delete(loop)
    loops.delete(loop)
    reserved.delete(loop)
    loop.end()
  }

  const create = (): WslCommandLoop => {
    const marker = wslCommandLoopMarker()
    const loop = startWslCommandLoop(options.spawnLoop(marker), marker)
    loops.add(loop)
    loop.onIdle(() => {
      if (disposed) {
        retire(loop)
        return
      }
      const timer = setTimeout(() => retire(loop), idleMs)
      timer.unref?.()
      idleTimers.set(loop, timer)
    })
    return loop
  }

  const reserve = (): WslCommandLoop | null => {
    for (const loop of loops) {
      if (!loop.alive) {
        retire(loop)
      } else if (!loop.busy && !reserved.has(loop)) {
        clearTimeout(idleTimers.get(loop))
        idleTimers.delete(loop)
        reserved.add(loop)
        return loop
      }
    }
    if (loops.size >= maxLoops) {
      return null
    }
    let loop: WslCommandLoop
    try {
      loop = create()
    } catch {
      // The caller's own wsl.exe start reports the real failure.
      unavailable = true
      return null
    }
    reserved.add(loop)
    return loop
  }

  return {
    async run(command, signal) {
      if (unavailable || disposed) {
        return null
      }
      if (signal?.aborted) {
        throw createSshOperationAbortError()
      }
      const loop = reserve()
      if (!loop) {
        return null
      }
      try {
        await waitReady(loop, readyTimeoutMs, signal)
      } catch {
        retire(loop)
        loop.kill()
        if (signal?.aborted) {
          throw createSshOperationAbortError()
        }
        unavailable = true
        return null
      }
      reserved.delete(loop)
      if (!loop.alive || loop.busy) {
        retire(loop)
        return null
      }
      return loop.run(command)
    },
    dispose() {
      disposed = true
      for (const loop of loops) {
        if (!loop.busy) {
          retire(loop)
        }
      }
    }
  }
}

function waitReady(loop: WslCommandLoop, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('The WSL command loop did not start')),
      timeoutMs
    )
    const onAbort = (): void => finish(createSshOperationAbortError())
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    loop.ready.then(() => finish(), finish)
  })
}
