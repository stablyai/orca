import { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'
import type { AtRestCommandScan } from '../../../native-chat/agent-session-wire/options/at-rest-command-catalog'
import type * as Source from './codex-at-rest-skills-probe'
import type { AtRestCommandDemand } from '../../../native-chat/agent-session-wire/options/at-rest-command-demand'
import type { CodexAppServerRpc } from '../../app-server/codex-app-server-session'
import {
  isCodexSkillRootsUnsupported,
  setCodexSkillRoots
} from '../launch/codex-structured-skill-roots'

const MAX_PROBE_PROCESSES = 2
const FAILED_START_BACKOFF_MS = [10_000, 30_000, 90_000, 5 * 60_000] as const

export type FolderRequest = {
  cwd: string
  isCurrent: () => boolean
  admitted: () => void
  answer: PromiseWithResolvers<AtRestCommandScan>
  cancel: () => void
  done: boolean
}

export type ProbeOwner = {
  accountHomePath: string
  command: string
  args: string[]
  environment: Record<string, string>
  /** The skill roots this process loads, set once; a different list gets another process. */
  roots: string[]
  /** An explicit menu read waits on it, so it is admitted ahead of eager reads. */
  demanded: boolean
  pending: Set<FolderRequest>
  active: Set<FolderRequest>
  cursor?: SetIterator<FolderRequest>
  controller: AbortController
  started: boolean
  wake?: () => void
}

type ProbePool = {
  failedStarts: number
  retryAt: number
  lastDemandAt: number
  expiry?: ReturnType<typeof setTimeout>
  owner?: ProbeOwner
}

/** A menu that asks now is admitted ahead of eager reads, including once its owner is queued. */
export function promoteOnDemand(
  demand: AtRestCommandDemand,
  owner: () => Pick<ProbeOwner, 'demanded'>
): () => void {
  const promote = (): void => {
    owner().demanded = true
  }
  if (demand.independent) {
    promote()
  }
  return demand.onRequest(promote)
}

/** Gives a probe its roots once: null when it may list (no roots, taken, or a Codex that can't load
 *  skills by path and lists what its chats would load); otherwise why it lists nothing. */
export async function setProbeRoots(
  rpc: Pick<CodexAppServerRpc, 'request'>,
  roots: string[]
): Promise<Error | null> {
  if (roots.length === 0) {
    return null
  }
  try {
    await setCodexSkillRoots(rpc, roots)
    return null
  } catch (error) {
    if (isCodexSkillRootsUnsupported(error)) {
      return null
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}

export function settle(request: FolderRequest, outcome: AtRestCommandScan | Error): void {
  if (request.done) {
    return
  }
  request.done = true
  request.cancel()
  if (outcome instanceof Error) {
    request.answer.reject(outcome)
  } else {
    request.answer.resolve(outcome)
  }
}

export function createCodexSkillsProbePools(
  deps: Source.CodexAtRestSkillsDeps,
  probe: typeof Source.probe
) {
  const now = deps.now ?? Date.now
  const processes = new PrioritySemaphore(MAX_PROBE_PROCESSES)
  const pools = new Map<string, ProbePool>()

  const expire = (key: string, pool: ProbePool): void => {
    clearTimeout(pool.expiry)
    if (pools.get(key) !== pool || pool.owner) {
      return
    }
    if (pool.failedStarts === 0) {
      pools.delete(key)
      return
    }
    pool.expiry = setTimeout(
      () => {
        if (pools.get(key) !== pool || pool.owner) {
          return
        }
        if (now() < Math.max(pool.lastDemandAt + 60 * 60_000, pool.retryAt)) {
          expire(key, pool)
        } else {
          pools.delete(key)
        }
      },
      Math.max(0, pool.lastDemandAt + 60 * 60_000 - now(), pool.retryAt - now())
    )
  }
  const run = async (key: string, pool: ProbePool, owner: ProbeOwner): Promise<void> => {
    let release: (() => void) | undefined
    let initialized = false
    try {
      release = await processes.acquire(() => (owner.demanded ? 0 : 1), owner.controller.signal)
      owner.controller.signal.throwIfAborted()
      if (owner.pending.size === 0) {
        return
      }
      await deps.prepareHome?.(owner.accountHomePath)
      owner.controller.signal.throwIfAborted()
      owner.started = true
      await probe(deps, owner, now(), () => {
        initialized = true
        pool.failedStarts = 0
      })
    } catch (error) {
      if (!owner.controller.signal.aborted && !initialized) {
        pool.failedStarts = Math.min(pool.failedStarts + 1, FAILED_START_BACKOFF_MS.length)
        pool.retryAt = now() + FAILED_START_BACKOFF_MS[pool.failedStarts - 1]
      }
      const failure = error instanceof Error ? error : new Error(String(error))
      for (const request of [...owner.pending, ...owner.active]) {
        settle(request, failure)
      }
      owner.pending.clear()
      owner.active.clear()
    } finally {
      // Invalidates callbacks that the session deadline raced out of, after actual close.
      owner.controller.abort()
      owner.wake?.()
      release?.()
      pool.owner = undefined
      if (owner.pending.size > 0 && now() >= pool.retryAt) {
        start(key, pool, {
          ...owner,
          controller: new AbortController(),
          started: false,
          wake: undefined
        })
      } else {
        for (const request of owner.pending) {
          settle(request, new Error('codex probe unavailable'))
        }
        owner.pending.clear()
        expire(key, pool)
      }
    }
  }
  const start = (key: string, pool: ProbePool, owner: ProbeOwner): void => {
    clearTimeout(pool.expiry)
    pool.owner = owner
    void run(key, pool, owner)
  }

  const dispose = (): void => {
    for (const pool of pools.values()) {
      clearTimeout(pool.expiry)
      pool.owner?.controller.abort()
      pool.owner?.wake?.()
    }
    pools.clear()
  }
  return { pools, start, expire, dispose }
}
