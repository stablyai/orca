import { isShellProcess } from '../../../../shared/shell-process-detection'
import { OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller } from '../../orchestration/terminal-authority/verify-orchestration-compatibility-caller'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { PtyForegroundProcessRead } from '../../runtime-terminal-contracts'

export abstract class OrcaRuntimeWithAgentLaunchRetirement extends OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller {
  protected abstract collectPaneKeysForPty(ptyId: string): Set<string>
  protected abstract retirePtyAgentLaunchAuthority(ptyId: string): void
  protected abstract readPtyForegroundProcessFromController(
    ptyId: string,
    afterTitleObservation?: number,
    afterPendingRead?: boolean
  ): Promise<PtyForegroundProcessRead> | null

  protected async retirePtyAgentLaunchAuthorityAfterCommandFinished(ptyId: string): Promise<void> {
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected) {
      return
    }
    pty.launchNeedsHookAttestation = true
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    const { launchToken, launchAgent, incarnationId } = pty
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const presence = await this.recheckHookAgentPresenceForPty(ptyId)
    // A suspended or backgrounded agent can still own this pane while a shell is foreground.
    if (presence === 'live' || presence === 'unverifiable') {
      return
    }
    if (!launchToken && !receipt && !launchAgent) {
      return
    }
    const hookObservationsUnchanged = captureAgentHookRetirementFence(
      this.collectPaneKeysForPty(ptyId),
      this.getAgentProviderSessionRowsForPaneFn,
      this.getAgentProviderSessionSnapshotFn ?? this.getAgentStatusSnapshotFn
    )
    // A shared read may predate this hook snapshot; wait for it and sample again.
    const result = await this.readPtyForegroundProcessFromController(
      ptyId,
      pty.lastOscTitleAt ?? 0,
      true
    )
    // OMP emits command-finished markers during live TUI redraws, not only on process exit.
    if (
      !result?.available ||
      result.controller !== this.ptyController ||
      !result.process ||
      !isShellProcess(result.process)
    ) {
      return
    }
    if (
      this.ptysById.get(ptyId) !== pty ||
      !pty.connected ||
      pty.incarnationId !== incarnationId ||
      this.getPtyLifecycleGeneration(ptyId) !== generation ||
      pty.launchToken !== launchToken ||
      pty.launchAgent !== launchAgent ||
      this.restoredOrchestrationAuthorityByPtyId.get(ptyId) !== receipt
    ) {
      return
    }
    if (!hookObservationsUnchanged()) {
      return
    }
    this.retirePtyAgentLaunchAuthority(ptyId)
  }
}

function sameAgentHookObservation(
  before: AgentStatusIpcPayload,
  after: AgentStatusIpcPayload
): boolean {
  return (
    before.paneKey === after.paneKey &&
    before.terminalHandle === after.terminalHandle &&
    before.launchToken === after.launchToken &&
    before.providerSession?.key === after.providerSession?.key &&
    before.providerSession?.id === after.providerSession?.id &&
    before.receivedAt === after.receivedAt &&
    before.evidenceObservedAt === after.evidenceObservedAt &&
    before.state === after.state &&
    before.observation?.authorityId === after.observation?.authorityId &&
    before.observation?.incarnation === after.observation?.incarnation &&
    before.observation?.revision === after.observation?.revision
  )
}

function readAgentHookRowsForPaneKeys(
  paneKeys: ReadonlySet<string>,
  readRowsForPane: ((paneKey: string) => AgentStatusIpcPayload[]) | null | undefined,
  readSnapshot: (() => AgentStatusIpcPayload[]) | null | undefined
): AgentStatusIpcPayload[] {
  if (readRowsForPane) {
    const rows: AgentStatusIpcPayload[] = []
    for (const paneKey of paneKeys) {
      rows.push(...readRowsForPane(paneKey))
    }
    return rows
  }
  return (readSnapshot?.() ?? []).filter((row) => paneKeys.has(row.paneKey))
}

function captureAgentHookRetirementFence(
  paneKeys: ReadonlySet<string>,
  readRowsForPane: ((paneKey: string) => AgentStatusIpcPayload[]) | null | undefined,
  readSnapshot: (() => AgentStatusIpcPayload[]) | null | undefined
): () => boolean {
  const before = readAgentHookRowsForPaneKeys(paneKeys, readRowsForPane, readSnapshot)
  return () => {
    const after = readAgentHookRowsForPaneKeys(paneKeys, readRowsForPane, readSnapshot)
    return (
      before.length === after.length &&
      before.every((row) => after.some((current) => sameAgentHookObservation(row, current)))
    )
  }
}
