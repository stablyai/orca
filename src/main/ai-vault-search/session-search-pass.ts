import {
  retireSessionSearchPassSources,
  wakeSessionSearchPassRetirements
} from './session-search-pass-retirement'
import type { SessionSearchPassState } from './session-search-pass-state'
export { SessionSearchPassState } from './session-search-pass-state'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../ai-vault/scanners/cursor/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import { withSessionDiscovery } from '../ai-vault/session-discovery-context'
import {
  mergeDegradedRoots,
  scanIssueDegradedRoots,
  unreadableRoots,
  type SessionSearchDegradedRoot
} from './session-search-degraded-roots'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import {
  discoverSessionSearchCandidates,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchIndexStore } from './session-search-store'

export type SessionSearchPassArgs = {
  store: SessionSearchIndexStore
  state: SessionSearchPassState
  roots: SessionSearchScanRoots
  full: boolean
  primaryWake?: number
  recentPerAgent: number
  previousRootsWithFiles?: ReadonlySet<string>
  purge?: boolean
  onPurged?: () => void
  startReadDeadline?: () => () => boolean
  discoveryOverdue?: () => boolean
  listings: SessionSearchDirectoryReader
  signal?: AbortSignal
}

export type SessionSearchPassResult = {
  rootsWithFiles: Set<string>
  degradedRoots: SessionSearchDegradedRoot[]
  completed: boolean
  outOfTime: boolean
  left: number
  pending: boolean
}

export async function runSessionSearchPass(
  args: SessionSearchPassArgs
): Promise<SessionSearchPassResult> {
  const { store, state, signal } = args
  await store.prepare?.()
  await state.prepare(store)
  if (args.purge ?? args.full) {
    await store.purgeOlderThan(store.retentionCutoff, signal)
    args.onPurged?.()
  }
  await state.candidates.beginPublications(args.full || !!args.purge)
  state.discovery.begin({
    full: args.full,
    primaryWake: args.primaryWake,
    maintenance: args.purge ?? args.full,
    recentLimit: args.recentPerAgent,
    overdue: args.discoveryOverdue ?? (() => false)
  })
  if (args.full) {
    state.needsRetirement = true
  }
  await wakeSessionSearchPassRetirements(args)
  return withCursorChatMetaScan(async () => {
    const accept = async (
      discoveries: Parameters<typeof state.candidates.update>[0],
      partial: boolean,
      existing?: Awaited<ReturnType<typeof state.candidates.update>>,
      forced: ReadonlySet<string> = new Set(),
      metadata: ReadonlySet<string> = new Set()
    ) => {
      let update =
        existing ??
        (await state.candidates.update(
          discoveries,
          new Set(),
          { ...args.roots, signal },
          forced,
          new Map(),
          partial,
          metadata
        ))
      if (update.work) {
        state.queue.update(update.work)
        await state.retire.refresh()
      }
      do {
        await state.parkedRetire.deletePage(
          update.candidates.map((candidate) => candidate.file.path)
        )
        state.queue.update(
          await state.candidates.admitChanges(update.receipts, !args.full, state.recovering)
        )
        if (!state.candidates.pendingChanges || args.discoveryOverdue?.()) {
          break
        }
        update = await state.candidates.update(
          [],
          new Set(),
          { ...args.roots, signal },
          new Set(),
          new Map(),
          true
        )
      } while (state.candidates.pendingChanges)
    }
    let discoveryLane = Promise.resolve()
    const serializeDiscovery = <T>(consume: () => Promise<T>): Promise<T> => {
      const accepted = discoveryLane.then(consume)
      discoveryLane = accepted.then(
        () => undefined,
        () => undefined
      )
      return accepted
    }
    state.discovery.onSeedAdmission((root, agent) =>
      serializeDiscovery(async () => {
        const rows = await state.candidates.changedForRoot(root, agent)
        if (rows.length) {
          await state.parkedRetire.deletePage(rows.map((row) => row.candidate.file.path))
          state.queue.update(
            await state.candidates.admitChanges(
              rows.map(({ key, revision }) => ({ key, revision })),
              !args.full,
              state.recovering
            )
          )
        }
        return !(await state.candidates.changedForRoot(root, agent)).length
      })
    )
    state.discovery.onRemoved((paths, observations) =>
      serializeDiscovery(async () => {
        if (!paths.length) {
          return
        }
        const work = await state.candidates.remove(new Set(paths), new Map(), observations)
        if (work) {
          state.queue.update(work)
          await state.retire.refresh()
        }
        await accept([], true)
      })
    )
    state.discovery.onDiscovery((discovery, forced, metadata) =>
      serializeDiscovery(() => accept([discovery], true, undefined, forced, metadata))
    )
    const swept = await withSessionDiscovery(state.discovery, () =>
      discoverSessionSearchCandidates(args.roots, { limitPerAgent: Infinity, signal, raw: true })
    ).finally(() => state.discovery.settled())
    await state.discovery.end()
    const issues: AiVaultScanIssue[] = [...swept.issues]
    const update = await state.candidates.update(
      swept.discoveries,
      state.discovery.removed,
      { ...args.roots, signal },
      new Set(),
      state.discovery.removedCandidates
    )
    await accept([], false, update)
    await state.discovery.containers.acknowledgeRetirements()
    if (!state.discovery.pending) {
      state.recovering = false
    }
    const readOverdue = args.startReadDeadline?.() ?? (() => false)
    const read = await runSessionSearchIndexPass(store, state.queue, {
      signal,
      overdue: readOverdue,
      publications: state.candidates,
      admit: async (work) => {
        const admission = await state.candidates.readAdmission(work.candidate)
        if (!state.queue.selectionCurrent(admission.work)) {
          return undefined
        }
        if (admission.work.work?.version !== work.version) {
          return undefined
        }
        work = admission.work.work
        const { candidate } = work
        const path = candidate.file.path
        const rootDir = admission.root
        if (rootDir === undefined) {
          await state.queue.acknowledge(work, false)
          return undefined
        }
        const observation = await state.discovery.observeForRead(
          candidate,
          rootDir,
          args.roots,
          !!work.metadata && !work.force,
          work.metadata
        )
        if (observation === null) {
          return work
        }
        if (observation.file === undefined) {
          // Observation debt owns retry/holdout; accepted facts cannot certify a refused input.
          await state.queue.acknowledge(work, false, observation.handoff)
          return undefined
        }
        if (!observation.changed) {
          return work
        }
        const refreshed = await state.candidates.update(
          [{ agent: candidate.agent, rootDir, files: [observation.file] }],
          new Set(),
          { ...args.roots, signal },
          observation.force ? new Set([path]) : new Set(),
          new Map(),
          true,
          observation.metadata ? new Set([path]) : new Set()
        )
        state.queue.update(
          await state.candidates.admitChanges(refreshed.receipts, !args.full, state.recovering)
        )
        await state.discovery.acknowledgeRead(candidate, rootDir, args.roots, observation.receipt)
        return state.queue.get(path)
      }
    })
    await state.candidates.reconcilePublications(
      store,
      readOverdue,
      signal,
      async (candidate, root) =>
        (await state.queue.hasPublicationDebt(candidate.file.path)) ||
        (await state.discovery.hasPublicationDebt(candidate, root, args.roots))
    )
    const listings = state.discovery.listings()
    const roots = listings.map((listing) => listing.root)
    const rootsWithFiles = new Set(
      listings.filter((listing) => listing.files > 0).map((listing) => listing.root)
    )
    const degraded = await retireSessionSearchPassSources(args, roots, rootsWithFiles)
    for (const refusal of cursorChatMetaRefusals()) {
      recordSessionScanIssue(issues, { agent: 'cursor', path: refusal.chatsRoot, ...refusal.text })
    }
    const unlistable = await unreadableRoots(
      listings
        .filter(({ root, absent }) => !absent && !rootsWithFiles.has(root))
        .map(({ root }) => root),
      args.listings,
      signal
    )
    await store.flush?.()
    return {
      rootsWithFiles,
      degradedRoots: mergeDegradedRoots(
        scanIssueDegradedRoots(roots, issues),
        degraded,
        unlistable
      ),
      completed: true,
      outOfTime: read.outOfTime,
      left: state.queue.left,
      pending: state.pending
    }
  })
}
