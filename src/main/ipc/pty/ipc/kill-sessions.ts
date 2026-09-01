import type { IPtyProvider, PtyProcessInfo } from '../../../providers/types'
import {
  MAX_PTY_KILL_SESSION_REFS,
  type PtyKillIntent,
  type PtyKillSessionRef,
  type PtyKillSessionResult
} from '../../../../shared/pty-kill-sessions'
import type { PtyShutdownResult } from '../../../providers/pty-provider-contract'
import { shutdownSinglePty, type SinglePtyKillDeps } from './shutdown-single'

export type KillSessionsDeps = {
  listProviders: () => readonly { provider: IPtyProvider; connectionId?: string | null }[]
  providerForSession: (id: string) => IPtyProvider | undefined
  /** Main-owned ownership evidence. `true` means the session is still claimed. */
  isOwned?: (ref: PtyKillSessionRef) => { owned: boolean; reason?: string }
  shutdown: (provider: IPtyProvider, ref: PtyKillSessionRef) => Promise<PtyShutdownResult | void>
  singleKill?: SinglePtyKillDeps
  supportsIncarnationFence?: (
    provider: IPtyProvider,
    sessionId: string
  ) => boolean | Promise<boolean>
  ownershipUnavailable?: (provider: IPtyProvider) => boolean
  concurrency?: number
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const result: R[] = Array.from({ length: values.length })
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= values.length) {
        return
      }
      result[index] = await fn(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()))
  return result
}

/** Bulk kill coordinator. Authorization is evaluated for every attempt and
 * owner-close deliberately bypasses orphan authorization. */
export async function killPtySessions(
  refs: readonly PtyKillSessionRef[],
  intent: PtyKillIntent,
  deps: KillSessionsDeps
): Promise<PtyKillSessionResult[]> {
  const acceptedRefs = refs.slice(0, MAX_PTY_KILL_SESSION_REFS)
  const rejectedRefs = refs.slice(MAX_PTY_KILL_SESSION_REFS).map((ref) => ({
    ...ref,
    verdict: 'refused' as const,
    reason: 'kill request exceeded the maximum batch size'
  }))
  const shutdownResults = new Map<string, PtyShutdownResult | void>()
  const fenceCapabilities = new Map<string, boolean>()
  const results = await mapWithConcurrency<PtyKillSessionRef, PtyKillSessionResult>(
    acceptedRefs,
    deps.concurrency ?? 4,
    async (ref): Promise<PtyKillSessionResult> => {
      const provider = deps.providerForSession(ref.id)
      if (provider && deps.ownershipUnavailable?.(provider)) {
        return { ...ref, verdict: 'unverifiable', reason: 'agent ownership unknown' }
      }
      const evidence = intent === 'orphan-cleanup' ? deps.isOwned?.(ref) : undefined
      if (evidence?.owned) {
        return { ...ref, verdict: 'refused', reason: evidence.reason ?? 'session is owned' }
      }
      const fenceCapable =
        provider && deps.supportsIncarnationFence
          ? await deps.supportsIncarnationFence(provider, ref.id)
          : false
      if (intent === 'orphan-cleanup') {
        const latest = deps.isOwned?.(ref)
        if (latest?.owned) {
          return { ...ref, verdict: 'refused', reason: latest.reason ?? 'session is owned' }
        }
      }
      fenceCapabilities.set(ref.id, fenceCapable)
      // Orphan cleanup must prove the exact incarnation before acting. Explicit
      // owner-close is already user-authorized and retains legacy id-only behavior
      // when the listing omits an incarnation.
      if (intent === 'orphan-cleanup' && fenceCapable && !ref.incarnationId) {
        return { ...ref, verdict: 'refused', reason: 'missing incarnation fence' }
      }
      try {
        const shutdownResult = deps.singleKill
          ? await shutdownSinglePty(
              { ...ref, intent, ...(provider ? { provider } : {}) },
              deps.singleKill
            )
          : provider
            ? await deps.shutdown(provider, ref)
            : undefined
        shutdownResults.set(ref.id, shutdownResult)
        if (shutdownResult?.fenceUnavailable) {
          return { ...ref, verdict: 'refused', reason: 'incarnation fence unavailable' }
        }
        return {
          ...ref,
          verdict: 'unverifiable' as const,
          reason: 'pending verification',
          // Older daemon/relay peers ignore the additive fence field. Preserve
          // today's kill behavior but expose that the identity door was absent.
          ...(!fenceCapable ? { fenceUnavailable: true as const } : {})
        }
      } catch (error) {
        return {
          ...ref,
          verdict: 'unverifiable',
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
  const snapshots = new Map<IPtyProvider, PtyProcessInfo[] | null>()
  await Promise.all(
    deps.listProviders().map(async ({ provider }) => {
      snapshots.set(provider, await provider.listProcesses().catch(() => null))
    })
  )
  const finalized: PtyKillSessionResult[] = results.map((result): PtyKillSessionResult => {
    if (result.verdict !== 'unverifiable' || result.reason !== 'pending verification') {
      return result
    }
    const provider = deps.providerForSession(result.id)
    const listed = provider ? snapshots.get(provider) : null
    if (!listed) {
      return { ...result, verdict: 'unverifiable', reason: 'inventory unavailable' }
    }
    const survivor = listed.find((row) => {
      if (row.id !== result.id) {
        return false
      }
      if (!fenceCapabilities.get(result.id) || !result.incarnationId) {
        return true
      }
      return row.incarnationId === result.incarnationId
    })
    const sameId = listed.find((row) => row.id === result.id)
    if (
      fenceCapabilities.get(result.id) &&
      result.incarnationId &&
      sameId &&
      !sameId.incarnationId
    ) {
      return { ...result, verdict: 'unverifiable', reason: 'incarnation evidence unavailable' }
    }
    if (
      fenceCapabilities.get(result.id) &&
      result.incarnationId &&
      sameId?.incarnationId &&
      sameId.incarnationId !== result.incarnationId
    ) {
      return { ...result, verdict: 'refused', reason: 'session was replaced' }
    }
    const shutdownResult = shutdownResults.get(result.id)
    const treeUnverified = Boolean(shutdownResult?.treeUnverified)
    const cleanResult =
      result.reason === 'pending verification'
        ? (() => {
            const copy = { ...result }
            delete copy.reason
            return copy
          })()
        : result
    if (!survivor && treeUnverified) {
      return {
        ...cleanResult,
        verdict: 'unverifiable' as const,
        reason: 'descendant tree could not be verified',
        treeUnverified: true
      }
    }
    return survivor
      ? {
          ...cleanResult,
          verdict: 'live' as const,
          reason: 'session still running',
          ...(treeUnverified ? { treeUnverified: true } : {})
        }
      : {
          ...cleanResult,
          verdict: 'exited' as const
        }
  })
  return [...finalized, ...rejectedRefs]
}

/** Utility used by the IPC adapter to take one pre-wave provider snapshot. */
export async function listProviderSessions(deps: KillSessionsDeps): Promise<PtyProcessInfo[]> {
  const snapshots = await Promise.all(
    deps.listProviders().map(({ provider }) => provider.listProcesses().catch(() => []))
  )
  return snapshots.flat()
}
