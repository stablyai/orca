import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  BoardClaimParams,
  BoardListParams,
  BoardPostParams,
  LockAcquireParams,
  LockListParams,
  LockReleaseParams
} from '../../../../../../shared/rpc-contract/orchestration-locks-params'

const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 600_000
const MAX_LOCK_WAIT_TIMEOUT_MS = 1_800_000
const LOCK_WAIT_POLL_INTERVAL_MS = 250

type LockWaiter = () => void
const resourceLockWaiters = new Map<string, Set<LockWaiter>>()

function notifyResourceLockWaiters(resourceKey: string): void {
  const waiters = resourceLockWaiters.get(resourceKey)
  if (!waiters || waiters.size === 0) {
    return
  }
  for (const wake of [...waiters]) {
    wake()
  }
}

function waitForLockChangeOrTimeout(
  resourceKey: string,
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      const waiters = resourceLockWaiters.get(resourceKey)
      if (waiters) {
        waiters.delete(finish)
        if (waiters.size === 0) {
          resourceLockWaiters.delete(resourceKey)
        }
      }
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(10, delayMs))
    timer.unref?.()
    let waiters = resourceLockWaiters.get(resourceKey)
    if (!waiters) {
      waiters = new Set()
      resourceLockWaiters.set(resourceKey, waiters)
    }
    waiters.add(finish)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) {
      finish()
    }
  })
}

export const ORCHESTRATION_LOCK_METHODS = [
  defineMethod({
    name: 'orchestration.lockAcquire',
    permission: 'workspace',
    params: LockAcquireParams,
    handler: async (params, { runtime, orchestrationCaller, signal }) => {
      const db = runtime.getOrchestrationDb()
      const ownerHandle = (
        params.from ??
        orchestrationCaller?.terminalHandle ??
        orchestrationCaller?.sessionId ??
        'agent'
      ).trim()
      const ownerPaneKey = orchestrationCaller?.paneKey ?? null
      const startedAtMs = Date.now()

      let attempt = db.acquireResourceLock({
        resourceKey: params.resource,
        ownerHandle,
        ownerPaneKey,
        reason: params.reason,
        ttlMs: params.ttlMs,
        nowMs: startedAtMs
      })

      if (!params.wait || attempt.position === 0) {
        return {
          lock: attempt.lock,
          position: attempt.position,
          holder: attempt.holder,
          waitedMs: 0
        }
      }

      const timeoutMs =
        params.timeoutMs === undefined
          ? DEFAULT_LOCK_WAIT_TIMEOUT_MS
          : Math.max(1, Math.min(MAX_LOCK_WAIT_TIMEOUT_MS, Math.trunc(params.timeoutMs)))
      const deadlineMs = startedAtMs + timeoutMs

      while (attempt.position > 0) {
        if (signal?.aborted) {
          db.releaseResourceLock({
            resourceKey: params.resource,
            ownerHandle
          })
          throw new OrchestrationError('request_aborted', 'Lock wait was cancelled.')
        }
        const nowMs = Date.now()
        const remainingMs = deadlineMs - nowMs
        if (remainingMs <= 0) {
          return {
            lock: attempt.lock,
            position: attempt.position,
            holder: attempt.holder,
            waitedMs: nowMs - startedAtMs,
            timedOut: true
          }
        }
        const holderExpiryDelta =
          attempt.holder.expires_at_ms !== null
            ? Math.max(25, attempt.holder.expires_at_ms - nowMs + 5)
            : LOCK_WAIT_POLL_INTERVAL_MS
        const sleepMs = Math.min(remainingMs, LOCK_WAIT_POLL_INTERVAL_MS, holderExpiryDelta)
        await waitForLockChangeOrTimeout(params.resource.trim(), sleepMs, signal)
        attempt = db.acquireResourceLock({
          resourceKey: params.resource,
          ownerHandle,
          ownerPaneKey,
          reason: params.reason,
          ttlMs: params.ttlMs
        })
      }

      return {
        lock: attempt.lock,
        position: 0,
        holder: attempt.holder,
        waitedMs: Date.now() - startedAtMs
      }
    }
  }),

  defineMethod({
    name: 'orchestration.lockRelease',
    permission: 'workspace',
    params: LockReleaseParams,
    handler: (params, { runtime, orchestrationCaller }) => {
      const db = runtime.getOrchestrationDb()
      const ownerHandle = (
        params.from ??
        orchestrationCaller?.terminalHandle ??
        orchestrationCaller?.sessionId ??
        'agent'
      ).trim()
      const result = db.releaseResourceLock({
        resourceKey: params.resource,
        ownerHandle,
        force: params.force === true
      })
      notifyResourceLockWaiters(params.resource.trim())
      return result
    }
  }),

  defineMethod({
    name: 'orchestration.lockList',
    permission: 'workspace',
    params: LockListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const locks = db.listResourceLocks({
        resourceKey: params.resource
      })
      return { locks, count: locks.length }
    }
  }),

  defineMethod({
    name: 'orchestration.boardPost',
    permission: 'workspace',
    params: BoardPostParams,
    handler: (params, { runtime, orchestrationCaller }) => {
      const db = runtime.getOrchestrationDb()
      const authorHandle = (
        params.from ??
        orchestrationCaller?.terminalHandle ??
        orchestrationCaller?.sessionId ??
        'agent'
      ).trim()
      const entry = db.postBoardEntry({
        scopeKey: params.scope,
        kind: params.kind,
        title: params.title,
        body: params.body,
        authorHandle,
        assigneeHandle: params.assignee
      })
      return { entry }
    }
  }),

  defineMethod({
    name: 'orchestration.boardClaim',
    permission: 'workspace',
    params: BoardClaimParams,
    handler: (params, { runtime, orchestrationCaller }) => {
      const db = runtime.getOrchestrationDb()
      const assigneeHandle = (
        params.from ??
        orchestrationCaller?.terminalHandle ??
        orchestrationCaller?.sessionId ??
        'agent'
      ).trim()
      const entry = db.claimBoardEntry({
        id: params.id,
        assigneeHandle,
        status: params.status
      })
      return { entry }
    }
  }),

  defineMethod({
    name: 'orchestration.boardList',
    permission: 'workspace',
    params: BoardListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const entries = db.listBoardEntries({
        scopeKey: params.scope,
        kind: params.kind,
        status: params.status,
        limit: params.limit
      })
      return { entries, count: entries.length }
    }
  })
]
