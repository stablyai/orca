import { retireSessionSearchPassSources } from './session-search-pass-retirement'
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
    maintenance: args.purge ?? args.full,
    recentLimit: args.recentPerAgent,
    overdue: args.discoveryOverdue ?? (() => false)
  })
  if (args.full) {
    state.needsRetirement = true
  }
  if (args.full || args.purge) {
    while (state.parkedRetire.size) {
      const first = await state.parkedRetire.firstEntry()
      if (!first) {
        break
      }
      await state.retire.set(first[0], first[0])
      await state.parkedRetire.delete(first[0])
    }
  }
  return withCursorChatMetaScan(async () => {
    const accept = async (
      discoveries: Parameters<typeof state.candidates.update>[0],
      partial: boolean,
      existing?: Awaited<ReturnType<typeof state.candidates.update>>
    ) => {
      let update =
        existing ??
        (await state.candidates.update(
          discoveries,
          new Set(),
          { ...args.roots, signal },
          state.discovery.forced,
          new Map(),
          partial,
          state.discovery.metadata
        ))
      do {
        for (const path of update.suppressed) {
          await state.queue.remove(path)
        }
        for (const candidate of update.candidates) {
          await store.prepareCoverage?.([candidate.file.path])
          await state.parkedRetire.delete(candidate.file.path)
          if (
            state.discovery.forced.has(candidate.file.path) ||
            update.forced.has(candidate.file.path) ||
            update.metadata.has(candidate.file.path)
          ) {
            await state.candidates.requirePublication(candidate.file.path)
          }
          await state.queue.enqueue(
            candidate,
            store,
            state.recovering ||
              state.discovery.forced.has(candidate.file.path) ||
              update.forced.has(candidate.file.path),
            !args.full,
            update.metadata.has(candidate.file.path)
          )
        }
        await state.candidates.acknowledgeChanges()
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
    state.discovery.onRemoved(async (paths) => {
      if (!paths.length) {
        return
      }
      await state.candidates.update(
        [],
        new Set(paths),
        { ...args.roots, signal },
        new Set(),
        new Map(),
        true
      )
      for (const path of paths) {
        if (!(await state.candidates.has(path))) {
          await state.queue.remove(path)
          await state.retire.set(path, path)
        }
      }
      await accept([], true)
    })
    state.discovery.onDiscovery((discovery) => accept([discovery], true))
    const swept = await withSessionDiscovery(state.discovery, () =>
      discoverSessionSearchCandidates(args.roots, { limitPerAgent: Infinity, signal, raw: true })
    )
    await state.discovery.end()
    const issues: AiVaultScanIssue[] = [...swept.issues]
    const update = await state.candidates.update(
      swept.discoveries,
      state.discovery.removed,
      { ...args.roots, signal },
      state.discovery.forced,
      state.discovery.removedCandidates
    )
    for (const path of update.suppressed) {
      await state.queue.remove(path)
    }
    for (const path of new Set([
      ...state.discovery.removed,
      ...state.discovery.removedCandidates.keys()
    ])) {
      if (await state.candidates.has(path, store.fileRow(path)?.agent)) {
        continue
      }
      await state.queue.remove(path)
      await state.retire.set(path, path)
    }
    await accept([], false, update)
    if (!state.discovery.pending) {
      state.recovering = false
    }
    const readOverdue = args.startReadDeadline?.() ?? (() => false)
    const read = await runSessionSearchIndexPass(store, state.queue, {
      signal,
      overdue: readOverdue,
      publications: state.candidates,
      admit: async (work) => {
        const { candidate } = work
        const path = candidate.file.path
        const rootDir = await state.candidates.rootFor(candidate)
        if (rootDir === undefined) {
          await state.queue.acknowledge(work, false)
          return undefined
        }
        const observation = await state.discovery.observeForRead(candidate, rootDir, args.roots)
        if (observation === null) {
          return work
        }
        if (!observation) {
          // Observation debt owns retry/holdout; accepted facts cannot certify a refused input.
          await state.queue.acknowledge(work, false)
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
          true
        )
        for (const suppressed of refreshed.suppressed) {
          await state.queue.remove(suppressed)
        }
        for (const selected of refreshed.candidates) {
          const force = observation.force || refreshed.forced.has(selected.file.path)
          if (force) {
            await state.candidates.requirePublication(selected.file.path)
          }
          await state.queue.enqueue(selected, store, force, !args.full)
        }
        await state.candidates.acknowledgeChanges()
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
      roots.filter((root) => !rootsWithFiles.has(root)),
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
