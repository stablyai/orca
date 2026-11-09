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
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import {
  discoverSessionSearchCandidates,
  sessionSearchEmptiedRoots,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchIndexStore, SessionSearchFileRow } from './session-search-store'
import { SessionSearchDiscoveryInventory } from './session-search-discovery-inventory'
import { SessionSearchCandidateInventory } from './session-search-candidate-inventory'
import { SessionSearchWorkQueue } from './session-search-work-queue'

export class SessionSearchPassState {
  readonly discovery: SessionSearchDiscoveryInventory
  readonly candidates = new SessionSearchCandidateInventory()
  readonly queue = new SessionSearchWorkQueue()
  retirement: Iterator<SessionSearchFileRow> | null = null
  readonly retire = new Set<string>()
  needsRetirement = true
  constructor(entryPath?: string) {
    this.discovery = new SessionSearchDiscoveryInventory(entryPath)
  }
  get pending(): boolean {
    return (
      this.discovery.pending ||
      this.queue.size > 0 ||
      this.retirement !== null ||
      this.retire.size > 0
    )
  }
  close(): Promise<void> {
    return this.discovery.close()
  }
}

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
  if (args.purge ?? args.full) {
    await store.purgeOlderThan(store.retentionCutoff, signal)
    args.onPurged?.()
  }
  state.discovery.begin({
    full: args.full,
    recentLimit: args.recentPerAgent,
    overdue: args.discoveryOverdue ?? (() => false)
  })
  if (args.full) {
    state.needsRetirement = true
  }
  return withCursorChatMetaScan(async () => {
    const swept = await withSessionDiscovery(state.discovery, () =>
      discoverSessionSearchCandidates(args.roots, { limitPerAgent: Infinity, signal, raw: true })
    )
    const issues: AiVaultScanIssue[] = [...swept.issues]
    const update = await state.candidates.update(
      swept.discoveries,
      state.discovery.removed,
      { ...args.roots, signal },
      state.discovery.forced
    )
    for (const path of update.suppressed) {
      state.queue.remove(path)
    }
    for (const path of state.discovery.removed) {
      state.queue.remove(path)
      state.retire.add(path)
    }
    for (const candidate of update.candidates) {
      state.queue.enqueue(
        candidate,
        store,
        state.discovery.forced.has(candidate.file.path) || update.forced.has(candidate.file.path),
        !args.full,
        state.discovery.metadata.has(candidate.file.path)
      )
    }
    const read = await runSessionSearchIndexPass(store, state.queue, {
      signal,
      overdue: args.startReadDeadline?.()
    })
    const listings = state.discovery.listings()
    const roots = listings.map((listing) => listing.root)
    const rootsWithFiles = new Set(
      listings.filter((listing) => listing.files > 0).map((listing) => listing.root)
    )
    const emptiedRoots = args.previousRootsWithFiles
      ? sessionSearchEmptiedRoots(args.previousRootsWithFiles, rootsWithFiles)
      : new Set<string>()
    const degraded: SessionSearchDegradedRoot[] = []
    if (!state.discovery.pending && state.needsRetirement) {
      state.retirement ??= store.fileRows()
      state.needsRetirement = false
    }
    let batches = 0
    const retry = new Set<string>()
    do {
      const paths: string[] = []
      for (const path of state.retire) {
        state.retire.delete(path)
        paths.push(path)
        if (paths.length === 512) {
          break
        }
      }
      let inspected = 0
      while (state.retirement && paths.length < 512 && inspected++ < 512) {
        const row = state.retirement.next()
        if (row.done) {
          state.retirement = null
          break
        }
        if (!state.candidates.has(row.value.path)) {
          paths.push(row.value.path)
        }
      }
      if (!paths.length) {
        if (!state.retirement || args.discoveryOverdue?.()) {
          break
        }
        continue
      }
      const retirement = await retireDeletedSessionSearchSources({
        store,
        paths,
        roots,
        emptiedRoots,
        enumeratedContainers: state.discovery.enumeratedContainers,
        listings: args.listings,
        directoryLimit: 512,
        signal
      })
      for (const path of [...retirement.unverifiable, ...retirement.unchecked]) {
        retry.add(path)
      }
      degraded.push(...retirement.degradedRoots)
      // Retry refused paths next cycle, but keep advancing the older retirement frontier now.
      batches++
    } while (
      (state.retirement || state.retire.size) &&
      (batches === 0 || !args.discoveryOverdue?.())
    )
    for (const path of retry) {
      state.retire.add(path)
    }
    for (const refusal of cursorChatMetaRefusals()) {
      recordSessionScanIssue(issues, { agent: 'cursor', path: refusal.chatsRoot, ...refusal.text })
    }
    const unlistable = await unreadableRoots(
      roots.filter((root) => !rootsWithFiles.has(root)),
      args.listings,
      signal
    )
    await store.flush?.()
    await state.discovery.end()
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
