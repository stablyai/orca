import { observeStructuredSession } from '../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import { listRegisteredPtys, type PtyRegistration } from '../../../memory/pty-registry'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import { listStructuredSessionsForWorktrees } from './structured-session-worktree-teardown'
import {
  indexWorktreeRemovalTargets,
  worktreeRemovalTargetKey,
  type WorktreeRemovalTarget
} from './worktree-removal-targets'
import {
  killAllProcessesForWorktree,
  WORKTREE_PROCESS_SWEEP_TIMEOUT_MS,
  type WorktreeTeardownRuntime
} from './worktree-teardown'
import {
  capturePtyStopOutcomes,
  finishPtyStopOutcome,
  indexFinalPtyStopProviderIdentities,
  ptyStopOutcomeIsCurrent
} from './worktree-pty-stop-outcomes'
import type { WorktreePtyStopOutcome } from './worktree-teardown-contract'
import { settleBeforeDeadline } from './settle-before-deadline'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'

/** Discovery is shared; each bucket keeps the single-workspace stop budget and primitives. */
export async function killAllProcessesForWorktrees(
  targets: readonly WorktreeRemovalTarget[],
  deps: {
    runtime: WorktreeTeardownRuntime
    localProvider: IPtyProvider | null
    onPtyStopped?: (ptyId: string) => void
  }
): Promise<ReadonlyMap<string, boolean>> {
  const outcomes = new Map(targets.map((target) => [worktreeRemovalTargetKey(target), false]))
  if (!targets.length) {
    return outcomes
  }
  let capture:
    | Awaited<ReturnType<NonNullable<WorktreeTeardownRuntime['captureWorktreeTerminalStops']>>>
    | undefined
  try {
    capture = await deps.runtime.captureWorktreeTerminalStops?.(targets)
  } catch (error) {
    console.warn('[worktree-teardown] terminal discovery unavailable:', error)
  }
  const index = indexWorktreeRemovalTargets(targets)
  const providerBuckets = new Map<string, PtyProcessInfo[]>()
  const registryBuckets = new Map<string, PtyRegistration[]>()
  let structuredVersion = 0
  const exitSubscriptions: (() => void)[] = []
  const ptyOutcomes = new Map<string, Map<string, WorktreePtyStopOutcome>>()
  const unsubscribe = sessionCrewChanges.subscribe((facets) => {
    if (facets.has('topology') || facets.has('records')) {
      structuredVersion++
    }
  })
  try {
    const structured = listStructuredSessionsForWorktrees(targets, deps.runtime)
    const inventory = deps.localProvider
      ? await settleBeforeDeadline(
          () =>
            deps.localProvider!.listProcesses({
              deadlineMs: Date.now() + WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
            }),
          null,
          Date.now() + WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
        )
      : null
    const providerIncarnations = new Map<string, PtyProcessInfo['incarnationId']>()
    for (const session of inventory ?? []) {
      if (session.id.startsWith('remote:')) {
        continue
      }
      providerIncarnations.set(session.id, session.incarnationId)
      const id = session.worktreeId ?? session.id.split('@@', 1)[0]
      const target = index.get(id)?.get(null)
      if (!target) {
        continue
      }
      const key = worktreeRemovalTargetKey(target)
      const bucket = providerBuckets.get(key) ?? []
      bucket.push(session)
      providerBuckets.set(key, bucket)
    }
    for (const entry of listRegisteredPtys()) {
      if (entry.ptyId.startsWith('remote:')) {
        continue
      }
      const target = entry.worktreeId && index.get(entry.worktreeId)?.get(null)
      if (!target) {
        continue
      }
      const key = worktreeRemovalTargetKey(target)
      const bucket = registryBuckets.get(key) ?? []
      bucket.push(entry)
      registryBuckets.set(key, bucket)
    }
    const candidates = new Map<string, Set<string>>()
    const structuredStopped = new Map<string, boolean>()
    for (const target of targets) {
      const key = worktreeRemovalTargetKey(target)
      const runtime = capture?.snapshots.get(key)
      const sessions = structured.sessions.get(key) ?? { members: [], live: [] }
      const provider = providerBuckets.get(key) ?? []
      const registry = registryBuckets.get(key) ?? []
      const ptyIds = new Set([
        ...(runtime?.ptyIds ?? []),
        ...provider.map((row) => row.id),
        ...registry.map((row) => row.ptyId)
      ])
      candidates.set(key, ptyIds)
      const candidateOutcomes = capturePtyStopOutcomes(
        [
          ...[...(runtime?.records ?? [])].map(
            ([id, row]) => [id, row?.incarnationId ?? undefined] as const
          ),
          ...provider.map((row) => [row.id, row.incarnationId] as const),
          ...registry.map((row) => [row.ptyId, providerIncarnations.get(row.ptyId)] as const),
          ...[...ptyIds].map((id) => [id, undefined] as const)
        ],
        deps.runtime,
        exitSubscriptions
      )
      ptyOutcomes.set(key, candidateOutcomes)
      // Missing graph discovery never becomes an empty authoritative inventory.
      const snapshot = runtime ?? {
        ptyIds: new Set<string>(),
        records: new Map(),
        assertCurrent: () => {}
      }
      try {
        const result = await killAllProcessesForWorktree(target.worktreeId, {
          runtime: deps.runtime,
          resolvedWorktreeId: target.worktreeId,
          resolvedConnectionId: target.connectionId,
          localProvider: deps.localProvider,
          closeStructuredSessions: true,
          includeProviderInventory: target.connectionId === null,
          includeLocalRegistry: target.connectionId === null,
          snapshot: {
            runtime: snapshot,
            provider: provider.map((row) => ({
              ...row,
              incarnationId: candidateOutcomes.get(row.id)?.incarnationId
            })),
            registry,
            structured: sessions,
            ptyOutcomes: candidateOutcomes
          }
        })
        structuredStopped.set(key, result.structuredStopConfirmed === true)
      } catch (error) {
        console.warn(`[worktree-teardown] incomplete folder sweep for ${target.worktreeId}:`, error)
      }
    }
    const localIds = [
      ...new Set(
        targets
          .filter((target) => target.connectionId === null)
          .flatMap((target) => [...(candidates.get(worktreeRemovalTargetKey(target)) ?? [])])
      )
    ]
    const remaining =
      deps.localProvider && inventory
        ? await settleBeforeDeadline(
            () =>
              deps.localProvider!.listProcesses({
                ptyIds: localIds,
                deadlineMs: Date.now() + WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
              }),
            null,
            Date.now() + WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
          )
        : null
    const finalIdentities = indexFinalPtyStopProviderIdentities(remaining ?? [])
    const stoppedByTarget = new Map<string, boolean>()
    for (const target of targets) {
      const key = worktreeRemovalTargetKey(target)
      const snapshot = capture?.snapshots.get(key)
      const providerEvidence =
        target.connectionId === null
          ? { worktreeId: target.worktreeId, identities: finalIdentities }
          : undefined
      const deadline = Date.now() + 10_000
      const entries = [...(ptyOutcomes.get(key) ?? [])]
      const finish = async ([id, candidate]: [string, WorktreePtyStopOutcome]) => {
        try {
          const providerAbsent =
            target.connectionId === null &&
            inventory !== null &&
            remaining !== null &&
            !finalIdentities.has(id)
          return await finishPtyStopOutcome(
            id,
            candidate,
            deps.runtime,
            snapshot,
            providerAbsent,
            deadline,
            deps.onPtyStopped,
            providerEvidence
          )
        } catch {
          return false
        }
      }
      // Settle ready siblings before bounded waits so hung retirements cannot consume their turn.
      const ready = entries.filter(([, candidate]) => candidate.retirementResult !== undefined)
      const pending = entries.filter(([, candidate]) => candidate.retirementResult === undefined)
      const readyResults = await mapWithConcurrency(ready, 32, finish)
      const pendingResults = await mapWithConcurrency(pending, 32, finish)
      stoppedByTarget.set(key, [...readyResults, ...pendingResults].every(Boolean))
    }
    // Visibility writes and exit retirement have settled; capture membership once at the outcome boundary.
    const version = structuredVersion
    const verified = listStructuredSessionsForWorktrees(targets)
    for (const target of targets) {
      const key = worktreeRemovalTargetKey(target)
      const before = structured.sessions.get(key) ?? { members: [], live: [] }
      const after = verified.sessions.get(key)
      const ids = new Set(before.members.map((member) => member.sessionId))
      const originallyLive = new Set(before.live.map((member) => member.sessionId))
      const membershipCurrent =
        after &&
        before.members.length === after.members.length &&
        after.members.every((member) => ids.has(member.sessionId)) &&
        after.live.every((member) => originallyLive.has(member.sessionId)) &&
        before.live.every(
          (member) => observeStructuredSession(member.sessionId).status === 'exited'
        )
      const snapshot = capture?.snapshots.get(key)
      const providerEvidence =
        target.connectionId === null
          ? { worktreeId: target.worktreeId, identities: finalIdentities }
          : undefined
      const candidatesCurrent = [...(ptyOutcomes.get(key) ?? [])].every(([id, candidate]) =>
        ptyStopOutcomeIsCurrent(id, candidate, snapshot, providerEvidence)
      )
      outcomes.set(
        key,
        Boolean(
          snapshot &&
          snapshot.leaseHeld !== false &&
          target.connectionId === null &&
          inventory !== null &&
          remaining !== null &&
          structured.complete &&
          verified.complete &&
          membershipCurrent &&
          structuredStopped.get(key) === true &&
          stoppedByTarget.get(key) &&
          candidatesCurrent &&
          version === structuredVersion
        )
      )
    }
    return outcomes
  } finally {
    unsubscribe()
    for (const release of exitSubscriptions) {
      release()
    }
    capture?.finish()
  }
}
