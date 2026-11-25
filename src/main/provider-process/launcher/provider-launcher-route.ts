import type { HostedProviderSpawnResult } from '../../daemon/protocol/daemon-provider-process-protocol'
import type { HostedWorkerThread } from '../../utility-worker-host/utility-worker-host-protocol'
import type { ProviderHostRoute, ProviderOwnerLauncher } from '../hosted-provider-launch'
import type { ProviderLauncherReply, ProviderLauncherRequest } from './provider-launcher-protocol'

type Pending = {
  resolve: (result: HostedProviderSpawnResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
type LauncherWorker = { thread: HostedWorkerThread; pending: Map<number, Pending> }

// A launcher that keeps dying (e.g. an entry that cannot load) stops being offered this session.
const MAX_CONSECUTIVE_LOSSES = 3

let spawnWorker: (() => HostedWorkerThread) | null = null
let current: LauncherWorker | null = null
let losses = 0
let nextId = 0

/** Electron main sets this; other hosts keep launching native owners themselves. */
export function setProviderLauncherSpawner(spawn: () => HostedWorkerThread): void {
  spawnWorker = spawn
}

function liveWorker(): LauncherWorker | null {
  if (current) {
    return current
  }
  if (!spawnWorker || losses >= MAX_CONSECUTIVE_LOSSES) {
    return null
  }
  const thread = spawnWorker()
  const worker: LauncherWorker = { thread, pending: new Map() }
  const lose = (error: Error): void => {
    if (current === worker) {
      current = null
      losses++
    }
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    worker.pending.clear()
  }
  thread.on('message', (reply: ProviderLauncherReply) => {
    const pending = worker.pending.get(reply.id)
    if (!pending) {
      return
    }
    losses = 0
    worker.pending.delete(reply.id)
    clearTimeout(pending.timer)
    if ('error' in reply) {
      pending.reject(new Error(reply.error))
    } else {
      pending.resolve(reply.result)
    }
  })
  thread.on('error', (error: Error) => {
    lose(error)
    void thread.terminate().catch(() => {})
  })
  thread.on('exit', (code: number) => lose(new Error(`Provider launcher exited with code ${code}`)))
  current = worker
  return worker
}

function request(
  worker: LauncherWorker,
  launch: ProviderLauncherRequest['launch'],
  timeoutMs: number
): Promise<HostedProviderSpawnResult> {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    // A late pid needs no cleanup: the caller closes the rendezvous, so that owner exits at its gate.
    const timer = setTimeout(() => {
      worker.pending.delete(id)
      reject(new Error('Provider launcher timed out'))
    }, timeoutMs)
    worker.pending.set(id, { resolve, reject, timer })
    try {
      worker.thread.postMessage({ id, launch } satisfies ProviderLauncherRequest)
    } catch (error) {
      worker.pending.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Native owners start in a small launcher process, so Electron main never forks its large
 * address space for a chat; the owner's pipes still connect straight back to main. */
export const providerLauncherRoute: ProviderHostRoute = {
  acquire: async () => {
    let worker: LauncherWorker | null
    try {
      worker = liveWorker()
    } catch {
      return null
    }
    if (!worker) {
      return null
    }
    const launcher: ProviderOwnerLauncher = {
      current: () => current === worker,
      spawn: (launch, timeoutMs) => request(worker, launch, timeoutMs)
    }
    return launcher
  }
}
