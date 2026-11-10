import os from 'node:os'
import {
  MAX_WORKTREE_ICON_BATCH,
  normalizeWorktreeIconName,
  type WorktreeIconGenerationResult
} from '../../shared/worktree/worktree-icon-generation'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import {
  canceledIconResult as canceledResult,
  generateWorktreeIconBatch,
  type WorktreeIconGenerationHost
} from './worktree-icon-batch-generation'
import { clearWorktreeIconCache as clearCacheFile, loadCache } from './worktree-icon-cache'

export type { WorktreeIconGenerationHost }

// Cards mounting in one render send their requests within a few ms; wait briefly so they share a batch.
const BATCH_COLLECT_MS = 100

type IconRequest = {
  host: WorktreeIconGenerationHost
  name: string
  consumers: number
  settled: boolean
  result: ReturnType<typeof Promise.withResolvers<WorktreeIconGenerationResult>>
}
type IconBatch = { members: IconRequest[]; controller: AbortController }
const inFlight = new Map<string, IconRequest>()
const queued = new Set<IconRequest>()
let active: IconBatch | undefined
let collectTimer: ReturnType<typeof setTimeout> | undefined

/** Drops every cached icon so the next render regenerates with the current recipe. */
export function clearWorktreeIconCache(host: WorktreeIconGenerationHost): void {
  clearCacheFile(host.cacheFile)
  for (const request of inFlight.values()) {
    queued.delete(request)
    settle(request, canceledResult())
  }
  if (active) {
    active.controller.abort()
    cancelLocalGeneration('worktree-icon', os.homedir())
  }
}

function forget(request: IconRequest): void {
  if (inFlight.get(request.name) === request) {
    inFlight.delete(request.name)
  }
}

function settle(request: IconRequest, result: WorktreeIconGenerationResult): void {
  if (request.settled) {
    return
  }
  request.settled = true
  forget(request)
  request.result.resolve(result)
}

function takeBatch(): IconRequest[] {
  const first = queued.values().next().value
  if (!first) {
    return []
  }
  const members: IconRequest[] = []
  for (const request of queued) {
    if (members.length >= MAX_WORKTREE_ICON_BATCH) {
      break
    }
    if (request.host !== first.host) {
      continue
    }
    queued.delete(request)
    // A name an earlier batch finished after its cards left needs no second agent run.
    const cached = loadCache(request.host.cacheFile).get(request.name)
    if (cached) {
      settle(request, { success: true, svg: cached })
      continue
    }
    members.push(request)
  }
  return members
}

// One agent at a time, many names per agent: the CLI's fixed prompt overhead dominates icon cost.
function drainQueue(): void {
  if (active || collectTimer) {
    return
  }
  collectTimer = setTimeout(() => {
    collectTimer = undefined
    if (active) {
      return
    }
    const members = takeBatch()
    if (members.length === 0) {
      if (queued.size > 0) {
        drainQueue()
      }
      return
    }
    const batch: IconBatch = { members, controller: new AbortController() }
    active = batch
    void generateWorktreeIconBatch(
      members[0].host,
      members.map((member) => member.name),
      batch.controller.signal
    )
      .catch((error: unknown): WorktreeIconGenerationResult[] =>
        members.map(() => ({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }))
      )
      .then((results) => {
        members.forEach((member, index) => settle(member, results[index]))
        active = undefined
        drainQueue()
      })
  }, BATCH_COLLECT_MS)
}

function abandon(request: IconRequest): void {
  forget(request)
  if (queued.delete(request)) {
    settle(request, canceledResult())
    return
  }
  const batch = active
  if (batch?.members.includes(request) && batch.members.every((member) => !member.consumers)) {
    batch.controller.abort()
    cancelLocalGeneration('worktree-icon', os.homedir())
  }
}

/** The cached icon for this name, or a batched generation that caches its result. */
export function generateWorktreeIconRequest(
  host: WorktreeIconGenerationHost,
  rawName: string,
  signal: AbortSignal
): Promise<WorktreeIconGenerationResult> {
  if (signal.aborted) {
    return Promise.resolve(canceledResult())
  }
  const name = normalizeWorktreeIconName(rawName)
  if (!name) {
    return Promise.resolve({ success: false, error: 'Workspace name is empty.' })
  }
  const cached = loadCache(host.cacheFile).get(name)
  if (cached) {
    return Promise.resolve({ success: true, svg: cached })
  }
  let request = inFlight.get(name)
  if (!request) {
    request = {
      host,
      name,
      consumers: 0,
      settled: false,
      result: Promise.withResolvers<WorktreeIconGenerationResult>()
    }
    inFlight.set(name, request)
    queued.add(request)
  }
  const owned = request
  owned.consumers++
  const result = new Promise<WorktreeIconGenerationResult>((resolve) => {
    let finished = false
    const finish = (result: WorktreeIconGenerationResult): void => {
      if (finished) {
        return
      }
      finished = true
      signal.removeEventListener('abort', cancel)
      owned.consumers--
      if (!owned.consumers && !owned.settled) {
        abandon(owned)
      }
      resolve(result)
    }
    const cancel = (): void => finish(canceledResult())
    signal.addEventListener('abort', cancel, { once: true })
    void owned.result.promise.then(finish)
  })
  drainQueue()
  return result
}
