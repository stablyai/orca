import { randomUUID } from 'node:crypto'
import {
  archivedTerminalTabSchema,
  normalizeTerminalArchiveRetentionDays,
  toArchivedTerminalTabSummary
} from '../shared/terminal-archive-types'
import type {
  ArchivedTerminalLayout,
  ArchivedTerminalPane,
  ArchivedTerminalTab,
  ArchivedTerminalTabSummary,
  RestoreTerminalArchiveResult,
  TerminalArchiveReason
} from '../shared/terminal-archive-types'
import type { TerminalArchiveSnapshotSource } from '../shared/workspace-session-terminal-archive'
import type { ExecutionHostId } from '../shared/execution-host'
import { deleteTerminalScrollbackSnapshotSync } from './terminal-scrollback-snapshots'
import type { TerminalScrollbackSnapshotStorage } from './terminal-scrollback-snapshots'
import { TerminalArchiveExpiryScheduler } from './terminal-archive-expiry-scheduler'
import {
  makeTerminalArchiveSourcePaneSignature,
  type TerminalArchiveSourcePaneIdentity
} from './terminal-archive-source-pane-signature'
import {
  deleteUnreferencedTerminalArchiveSnapshots,
  stageTerminalArchivePaneSnapshot
} from './terminal-archive-snapshot-staging'
import { TerminalArchiveError } from './terminal-archive-failure'

export type ArchiveTerminalTabRequest = {
  operationId: string
  sourceTabId: string
  executionHostId: ExecutionHostId
  runtimeEnvironmentId?: string
  worktreeId: string
  title: string
  defaultTitle?: string
  color?: string | null
  layout: ArchivedTerminalLayout
  panesByLeafId: Record<string, ArchivedTerminalPane>
  sourcePaneIdentityByLeafId: Record<string, TerminalArchiveSourcePaneIdentity>
  reason: TerminalArchiveReason
  createdAt?: number
  capturedAt?: number
  /** Ignored so a caller cannot set the archive TTL or GC clock. */
  archivedAt?: number
}

export type TerminalArchiveListFilter = {
  executionHostId?: ExecutionHostId
  worktreeId?: string
}

export type TerminalArchiveRestoreTarget = {
  executionHostId?: ExecutionHostId
}

export type PruneResult = {
  prunedIds: string[]
  deletedSnapshotRefs: string[]
}

export type TerminalArchiveRepository = {
  getTerminalArchives(): Record<string, ArchivedTerminalTab>
  replaceTerminalArchivesAndFlush(archives: Record<string, ArchivedTerminalTab>): void
  getTerminalArchiveRetentionDays(): number
  isExecutionHostReachable(hostId: ExecutionHostId): boolean
  worktreeExists(worktreeId: string, hostId: ExecutionHostId): boolean
  /** Must fail closed before and after snapshot capture. */
  isTerminalArchiveRequestOwned(request: {
    executionHostId: ExecutionHostId
    worktreeId: string
    sourceTabId: string
    sourcePaneIdentityByLeafId: Record<string, TerminalArchiveSourcePaneIdentity>
  }): boolean
  isTerminalScrollbackSnapshotLive(ref: string): boolean
  terminalScrollbackSnapshotStorage?: TerminalScrollbackSnapshotStorage
}

export class TerminalArchiveStore {
  private serial: Promise<void> = Promise.resolve()
  private readonly expiryScheduler: TerminalArchiveExpiryScheduler

  constructor(
    private readonly repository: TerminalArchiveRepository,
    private readonly snapshotSource: TerminalArchiveSnapshotSource,
    private readonly now: () => number = () => Date.now()
  ) {
    this.expiryScheduler = new TerminalArchiveExpiryScheduler(this.now, () =>
      this.pruneExpiredTerminalArchives(this.now()).then(() => undefined)
    )
    this.schedulePrune()
  }

  archiveTerminalTab(request: ArchiveTerminalTabRequest): Promise<ArchivedTerminalTab> {
    return this.runSerial(async () => {
      this.assertRequestOwned(request)
      const now = this.now()
      this.pruneAt(now)
      const sourcePaneSignature = makeTerminalArchiveSourcePaneSignature(
        request.panesByLeafId,
        request.sourcePaneIdentityByLeafId
      )
      const operationArchives = Object.values(this.repository.getTerminalArchives()).filter(
        (archive) =>
          archive.operationId === request.operationId &&
          archive.executionHostId === request.executionHostId &&
          archive.sourceTabId === request.sourceTabId
      )
      const existing = operationArchives.find(
        (archive) => archive.sourcePaneSignature === sourcePaneSignature
      )
      if (
        operationArchives.some((archive) => archive.sourcePaneSignature !== sourcePaneSignature)
      ) {
        throw new TerminalArchiveError('stale-source')
      }

      const archiveId = existing?.id ?? randomUUID()
      const snapshotVersion = randomUUID()
      const panesByLeafId: Record<string, ArchivedTerminalPane> = {}
      const writtenRefs: string[] = []
      try {
        for (const [leafId, pane] of Object.entries(request.panesByLeafId)) {
          const snapshot = await this.snapshotSource.capture(pane)
          if (snapshot.kind === 'unavailable') {
            throw new TerminalArchiveError('capture-unavailable')
          }
          if (snapshot.kind === 'captured-empty') {
            panesByLeafId[leafId] = pane
            continue
          }
          const staged = stageTerminalArchivePaneSnapshot({
            archiveId,
            snapshotVersion,
            pane,
            snapshot,
            storage: this.repository.terminalScrollbackSnapshotStorage
          })
          panesByLeafId[leafId] = staged.pane
          if (staged.writtenRef) {
            writtenRefs.push(staged.writtenRef)
          }
        }
        const archive = archivedTerminalTabSchema.parse({
          schemaVersion: 1,
          id: archiveId,
          operationId: request.operationId,
          sourceTabId: request.sourceTabId,
          sourcePaneSignature,
          executionHostId: request.executionHostId,
          ...(request.runtimeEnvironmentId
            ? { runtimeEnvironmentId: request.runtimeEnvironmentId }
            : {}),
          worktreeId: request.worktreeId,
          title: request.title,
          ...(request.defaultTitle ? { defaultTitle: request.defaultTitle } : {}),
          ...(request.color !== undefined ? { color: request.color } : {}),
          layout: request.layout,
          panesByLeafId,
          reason: request.reason,
          ...(request.createdAt !== undefined ? { createdAt: request.createdAt } : {}),
          ...(request.capturedAt !== undefined ? { capturedAt: request.capturedAt } : {}),
          archivedAt: now,
          expiresAt:
            now +
            normalizeTerminalArchiveRetentionDays(
              this.repository.getTerminalArchiveRetentionDays()
            ) *
              24 *
              60 *
              60 *
              1_000,
          ...(existing?.lastRestoredAt !== undefined
            ? { lastRestoredAt: existing.lastRestoredAt }
            : {}),
          restoreCount: existing?.restoreCount ?? 0
        }) as ArchivedTerminalTab
        // Capture awaits external sources, so recheck the exact main-owned fence before commit.
        this.assertRequestOwned(request)
        this.repository.replaceTerminalArchivesAndFlush({
          ...this.repository.getTerminalArchives(),
          [archive.id]: archive
        })
        if (existing) {
          deleteUnreferencedTerminalArchiveSnapshots({
            archives: [existing],
            isLive: (ref) => this.repository.isTerminalScrollbackSnapshotLive(ref),
            storage: this.repository.terminalScrollbackSnapshotStorage
          })
        }
        this.schedulePrune()
        return archive
      } catch (error) {
        for (const ref of writtenRefs) {
          deleteTerminalScrollbackSnapshotSync(
            ref,
            this.repository.terminalScrollbackSnapshotStorage
          )
        }
        throw error
      }
    })
  }

  listTerminalArchives(
    filter: TerminalArchiveListFilter = {}
  ): Promise<ArchivedTerminalTabSummary[]> {
    return this.runSerial(async () => {
      this.pruneAt(this.now())
      return Object.values(this.repository.getTerminalArchives())
        .filter(
          (archive) =>
            (!filter.executionHostId || archive.executionHostId === filter.executionHostId) &&
            (!filter.worktreeId || archive.worktreeId === filter.worktreeId)
        )
        .sort((left, right) => right.archivedAt - left.archivedAt)
        .map((archive) =>
          toArchivedTerminalTabSummary(archive, {
            worktreeMissing: !this.repository.worktreeExists(
              archive.worktreeId,
              archive.executionHostId
            )
          })
        )
    })
  }

  restoreTerminalArchive(
    id: string,
    target: TerminalArchiveRestoreTarget = {}
  ): Promise<RestoreTerminalArchiveResult> {
    return this.runSerial(async () => {
      const now = this.now()
      const beforePrune = this.repository.getTerminalArchives()[id]
      if (beforePrune?.expiresAt <= now) {
        this.pruneAt(now)
        return { ok: false, code: 'archive_expired', archiveId: id }
      }
      this.pruneAt(now)
      const archive = this.repository.getTerminalArchives()[id]
      if (!archive) {
        return { ok: false, code: 'archive_not_found', archiveId: id }
      }
      if (archive.expiresAt <= now) {
        return { ok: false, code: 'archive_expired', archiveId: id }
      }
      if (target.executionHostId && target.executionHostId !== archive.executionHostId) {
        return { ok: false, code: 'archive_host_mismatch', archiveId: id }
      }
      // B2 replaces this metadata preflight with a live execution-host probe.
      if (!this.repository.isExecutionHostReachable(archive.executionHostId)) {
        return { ok: false, code: 'archive_host_unreachable', archiveId: id }
      }
      if (!this.repository.worktreeExists(archive.worktreeId, archive.executionHostId)) {
        return { ok: false, code: 'archive_worktree_missing', archiveId: id }
      }
      return { ok: false, code: 'not_implemented', archiveId: id }
    })
  }

  pruneExpiredTerminalArchives(now: number): Promise<PruneResult> {
    return this.runSerial(async () => this.pruneAt(now))
  }

  dispose(): void {
    this.expiryScheduler.dispose()
  }

  private assertRequestOwned(request: ArchiveTerminalTabRequest): void {
    if (
      this.repository.isTerminalArchiveRequestOwned({
        executionHostId: request.executionHostId,
        worktreeId: request.worktreeId,
        sourceTabId: request.sourceTabId,
        sourcePaneIdentityByLeafId: request.sourcePaneIdentityByLeafId
      }) !== true
    ) {
      throw new TerminalArchiveError('not-owned')
    }
  }

  private pruneAt(now: number): PruneResult {
    const archives = this.repository.getTerminalArchives()
    const expired = Object.values(archives).filter((archive) => archive.expiresAt <= now)
    if (expired.length === 0) {
      this.schedulePrune()
      return { prunedIds: [], deletedSnapshotRefs: [] }
    }
    const next = { ...archives }
    for (const archive of expired) {
      delete next[archive.id]
    }
    // Metadata must be durable before removing bytes; a crash can leave only harmless orphans.
    this.repository.replaceTerminalArchivesAndFlush(next)
    const deletedSnapshotRefs = deleteUnreferencedTerminalArchiveSnapshots({
      archives: expired,
      isLive: (ref) => this.repository.isTerminalScrollbackSnapshotLive(ref),
      storage: this.repository.terminalScrollbackSnapshotStorage
    })
    this.schedulePrune()
    return { prunedIds: expired.map((archive) => archive.id), deletedSnapshotRefs }
  }

  private schedulePrune(): void {
    const nextExpiry = Object.values(this.repository.getTerminalArchives()).reduce<number | null>(
      (nearest, archive) =>
        nearest === null || archive.expiresAt < nearest ? archive.expiresAt : nearest,
      null
    )
    this.expiryScheduler.schedule(nextExpiry)
  }

  private runSerial<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.serial.then(operation, operation)
    this.serial = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
