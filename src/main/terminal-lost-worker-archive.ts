import { captureTerminalArchiveTab } from '../shared/workspace-session-terminal-archive'
import type { TerminalArchiveSnapshotSource } from '../shared/workspace-session-terminal-archive'
import type { ExecutionHostId } from '../shared/execution-host'
import type { RelayPtyLostEntry } from '../shared/pty-revive-protocol'
import type { TerminalArchiveReason, ArchivedTerminalTab } from '../shared/terminal-archive-types'
import type { WorkspaceSessionState } from '../shared/types'
import { makeTerminalArchiveSourcePaneSignature } from './terminal-archive-source-pane-signature'
import type { TerminalArchiveSourcePaneIdentity } from './terminal-archive-source-pane-signature'
import type { TerminalArchiveStore } from './terminal-archive-store'
import { TerminalArchiveError } from './terminal-archive-failure'
import { writeLostWorkerTerminalArchive } from './terminal-lost-worker-archive-write'

type LostWorkerArchiveReason = Exclude<TerminalArchiveReason, 'user-close'>

const lostWorkerArchiveInFlight = new Map<string, Promise<TerminalLostWorkerArchiveResult>>()

export type TerminalLostWorkerArchiveCandidate = {
  reason: LostWorkerArchiveReason
  executionHostId: ExecutionHostId
  worktreeId: string
  tabId: string
  runtimeEnvironmentId?: string
  sshTerminationTargetId?: string
  expectedSourcePaneIdentityByLeafId: Record<string, TerminalArchiveSourcePaneIdentity>
  relayEvidence?: Pick<
    RelayPtyLostEntry,
    | 'id'
    | 'sourceIncarnationId'
    | 'paneKey'
    | 'tabId'
    | 'worktreeId'
    | 'terminalHandle'
    | 'replayTail'
    | 'durableLaunch'
    | 'providerSession'
    | 'orchestrationTaskId'
  >
}

export type TerminalLostWorkerArchiveOwner = {
  getWorkspaceSession(hostId: ExecutionHostId): WorkspaceSessionState
  createTerminalArchiveStore(snapshotSource: TerminalArchiveSnapshotSource): TerminalArchiveStore
}

export type TerminalLostWorkerArchiveReceipt = {
  kind: 'archived'
  archive: ArchivedTerminalTab
  operationId: string
  ptyIdsToKill: string[]
}

export type TerminalLostWorkerArchiveResult =
  | TerminalLostWorkerArchiveReceipt
  | {
      kind: 'error'
      code:
        | 'not-owned'
        | 'stale-source'
        | 'capture-unavailable'
        | 'contract-invalid'
        | 'durability-failed'
    }

function sourceIdentityMatches(
  expected: Record<string, TerminalArchiveSourcePaneIdentity>,
  actual: Record<string, TerminalArchiveSourcePaneIdentity>
): boolean {
  const expectedLeaves = Object.keys(expected)
  return (
    expectedLeaves.length === Object.keys(actual).length &&
    expectedLeaves.every(
      (leafId) =>
        expected[leafId]?.paneKey === actual[leafId]?.paneKey &&
        expected[leafId]?.incarnationId === actual[leafId]?.incarnationId
    )
  )
}

function relayEvidenceMatchesSource(candidate: TerminalLostWorkerArchiveCandidate): boolean {
  const sourceIncarnationId = candidate.relayEvidence?.sourceIncarnationId
  if (!sourceIncarnationId) {
    return true
  }
  const sourcePaneKey = candidate.relayEvidence?.paneKey
  return Boolean(
    sourcePaneKey &&
    Object.values(candidate.expectedSourcePaneIdentityByLeafId).some(
      (identity) =>
        identity.paneKey === sourcePaneKey && identity.incarnationId === sourceIncarnationId
    )
  )
}

function terminalArchiveFailureCode(
  error: unknown
): Extract<TerminalLostWorkerArchiveResult, { kind: 'error' }>['code'] {
  if (error instanceof TerminalArchiveError) {
    return error.code
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return 'contract-invalid'
  }
  return 'durability-failed'
}

/** Archives main-owned lost-worker state before exposing any retirement authority. */
export async function archiveLostTerminalWorker(args: {
  owner: TerminalLostWorkerArchiveOwner
  candidate: TerminalLostWorkerArchiveCandidate
  frozenSession: WorkspaceSessionState
  snapshotSource: TerminalArchiveSnapshotSource
  completeArchive?: (args: {
    archive: ArchivedTerminalTab
    ptyIdsToKill: readonly string[]
  }) => Promise<void>
}): Promise<TerminalLostWorkerArchiveResult> {
  if (!relayEvidenceMatchesSource(args.candidate)) {
    return { kind: 'error', code: 'stale-source' }
  }
  const persistedSession = args.owner.getWorkspaceSession(args.candidate.executionHostId)
  const session = {
    ...args.frozenSession,
    terminalArchiveHintsByPaneKey: persistedSession.terminalArchiveHintsByPaneKey,
    terminalPtyIncarnationsByPaneKey: persistedSession.terminalPtyIncarnationsByPaneKey
  }
  const captured = captureTerminalArchiveTab({
    session,
    worktreeId: args.candidate.worktreeId,
    tabId: args.candidate.tabId
  })
  if (!captured) {
    return { kind: 'error', code: 'capture-unavailable' }
  }
  if (
    !sourceIdentityMatches(
      args.candidate.expectedSourcePaneIdentityByLeafId,
      captured.sourcePaneIdentityByLeafId
    )
  ) {
    return { kind: 'error', code: 'stale-source' }
  }
  const sourcePaneSignature = makeTerminalArchiveSourcePaneSignature(
    captured.panesByLeafId,
    captured.sourcePaneIdentityByLeafId
  )
  const operationId = `${args.candidate.reason}:${args.candidate.tabId}:${sourcePaneSignature}`
  const inFlightKey = `${args.candidate.reason}:${args.candidate.executionHostId}:${args.candidate.tabId}:${sourcePaneSignature}`
  const existing = lostWorkerArchiveInFlight.get(inFlightKey)
  if (existing) {
    return await existing
  }
  const operation = archiveLostTerminalWorkerOnce({
    ...args,
    captured,
    operationId
  })
  lostWorkerArchiveInFlight.set(inFlightKey, operation)
  try {
    return await operation
  } finally {
    if (lostWorkerArchiveInFlight.get(inFlightKey) === operation) {
      lostWorkerArchiveInFlight.delete(inFlightKey)
    }
  }
}

async function archiveLostTerminalWorkerOnce(args: {
  owner: TerminalLostWorkerArchiveOwner
  candidate: TerminalLostWorkerArchiveCandidate
  frozenSession: WorkspaceSessionState
  snapshotSource: TerminalArchiveSnapshotSource
  completeArchive?: (args: {
    archive: ArchivedTerminalTab
    ptyIdsToKill: readonly string[]
  }) => Promise<void>
  captured: NonNullable<ReturnType<typeof captureTerminalArchiveTab>>
  operationId: string
}): Promise<TerminalLostWorkerArchiveResult> {
  const archiveStore = args.owner.createTerminalArchiveStore(args.snapshotSource)
  try {
    const archived = await writeLostWorkerTerminalArchive(
      archiveStore,
      {
        operationId: args.operationId,
        sourceTabId: args.candidate.tabId,
        executionHostId: args.candidate.executionHostId,
        ...(args.candidate.runtimeEnvironmentId
          ? { runtimeEnvironmentId: args.candidate.runtimeEnvironmentId }
          : {}),
        worktreeId: args.candidate.worktreeId,
        title: args.captured.tab.customTitle || args.captured.tab.title,
        ...(args.captured.tab.defaultTitle ? { defaultTitle: args.captured.tab.defaultTitle } : {}),
        ...(args.captured.tab.color !== undefined ? { color: args.captured.tab.color } : {}),
        layout: args.captured.layout,
        panesByLeafId: args.captured.panesByLeafId,
        sourcePaneIdentityByLeafId: args.captured.sourcePaneIdentityByLeafId,
        reason: args.candidate.reason,
        createdAt: args.captured.tab.createdAt,
        capturedAt: Date.now()
      },
      {
        worktreeId: args.candidate.worktreeId,
        tabId: args.candidate.tabId,
        executionHostId: args.candidate.executionHostId,
        ...(args.candidate.sshTerminationTargetId
          ? { sshTerminationTargetId: args.candidate.sshTerminationTargetId }
          : {})
      }
    )
    try {
      await args.completeArchive?.({
        archive: archived.archive,
        ptyIdsToKill: archived.ptyIdsToKill
      })
    } catch (error) {
      // Why: metadata and retirement are already durable, so completion failures cannot reopen the transaction.
      console.warn('[terminal-lost-worker-archive] completion diagnostic', {
        reason: args.candidate.reason,
        executionHostId: args.candidate.executionHostId,
        tabId: args.candidate.tabId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return {
      kind: 'archived',
      archive: archived.archive,
      operationId: args.operationId,
      ptyIdsToKill: archived.ptyIdsToKill
    }
  } catch (error) {
    return { kind: 'error', code: terminalArchiveFailureCode(error) }
  } finally {
    archiveStore.dispose()
  }
}
