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

type LostWorkerArchiveReason = Exclude<TerminalArchiveReason, 'user-close'>

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
  retireArchivedTerminalTabAndFlush(args: {
    worktreeId: string
    tabId: string
    executionHostId: ExecutionHostId
    sshTerminationTargetId?: string
  }): { closed: boolean; ptyIdsToKill: string[] }
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
  const archiveStore = args.owner.createTerminalArchiveStore(args.snapshotSource)
  try {
    const archive = await archiveStore.archiveTerminalTab({
      operationId,
      sourceTabId: args.candidate.tabId,
      executionHostId: args.candidate.executionHostId,
      ...(args.candidate.runtimeEnvironmentId
        ? { runtimeEnvironmentId: args.candidate.runtimeEnvironmentId }
        : {}),
      worktreeId: args.candidate.worktreeId,
      title: captured.tab.customTitle || captured.tab.title,
      ...(captured.tab.defaultTitle ? { defaultTitle: captured.tab.defaultTitle } : {}),
      ...(captured.tab.color !== undefined ? { color: captured.tab.color } : {}),
      layout: captured.layout,
      panesByLeafId: captured.panesByLeafId,
      sourcePaneIdentityByLeafId: captured.sourcePaneIdentityByLeafId,
      reason: args.candidate.reason,
      createdAt: captured.tab.createdAt,
      capturedAt: Date.now()
    })
    const retired = args.owner.retireArchivedTerminalTabAndFlush({
      worktreeId: args.candidate.worktreeId,
      tabId: args.candidate.tabId,
      executionHostId: args.candidate.executionHostId,
      ...(args.candidate.sshTerminationTargetId
        ? { sshTerminationTargetId: args.candidate.sshTerminationTargetId }
        : {})
    })
    if (!retired.closed) {
      return { kind: 'error', code: 'stale-source' }
    }
    return { kind: 'archived', archive, operationId, ptyIdsToKill: retired.ptyIdsToKill }
  } catch (error) {
    return { kind: 'error', code: terminalArchiveFailureCode(error) }
  } finally {
    archiveStore.dispose()
  }
}
