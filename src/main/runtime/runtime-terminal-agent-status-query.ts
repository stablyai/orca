import {
  detectAgentStatusFromTitle,
  isOpenCodeNativeTitle,
  isQuarterCircleSpinnerOnlyAgentTitle,
  isShellProcess,
  type AgentStatus
} from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  terminalTitleBlocksExplicitAgentStatus,
  getDisplayPromptLifecycle,
  getLatestAgentCandidateTitleInfo,
  getLeafDisplayRecord,
  getPtyDisplayRecord,
  type TitleDisplayClear
} from './runtime-worktree-status-projection'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import { getTerminalState } from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

export type RuntimeTerminalAgentStatusSnapshot = {
  waitText: string
  waitBlockedAt: number | null
  title: string | null
  titleStatus: AgentStatus | null
  titleStatusIsLive: boolean
}

type Dependencies = {
  getController(): RuntimePtyController | null
  getLivePty(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  getLiveLeaf(handle: string): { leaf: RuntimeLeafRecord }
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTabTitle(tabId: string): string | null
  getExplicitStatus(
    handle: string
  ): { status: NonNullable<RuntimeTerminalAgentStatus['status']>; updatedAt: number } | null
  getLifecycleStatus(
    ptyId: string
  ): { status: AgentStatus | null; updatedAt: number } | null | undefined
  isRunning(handle: string): Promise<boolean>
  getTitleDisplayClear(ptyId: string): TitleDisplayClear | null
}

export class RuntimeTerminalAgentStatusQuery {
  private readonly inFlight = new Map<string, Promise<RuntimeTerminalAgentStatus>>()

  constructor(private readonly deps: Dependencies) {}

  async getStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const existing = this.inFlight.get(handle)
    if (existing) {
      return existing
    }
    const request = this.readStatus(handle)
    this.inFlight.set(handle, request)
    try {
      return await request
    } finally {
      if (this.inFlight.get(handle) === request) {
        this.inFlight.delete(handle)
      }
    }
  }

  private async readStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const ptyId = this.getPtyId(handle)
    // Why display: whether an agent is here is read off what the pane shows, as before the
    // stale-working clear stopped rewriting records; a cwd spinner clears to a neutral title,
    // so the foreground process decides for an agent that exited behind it.
    const clear = this.deps.getTitleDisplayClear(ptyId)
    const terminal = this.getSnapshot(handle, ptyId, clear)
    const explicitStatus = this.deps.getExplicitStatus(handle)
    const lifecycle = getDisplayPromptLifecycle(this.deps.getLifecycleStatus(ptyId), clear)
    const blockedByWaitText = detectTerminalWaitBlockedReason(terminal.waitText)
    const liveTitleClearsBlockedText =
      terminal.titleStatusIsLive &&
      terminal.titleStatus !== null &&
      terminal.titleStatus !== 'permission' &&
      !isOpenCodeNativeTitle(terminal.title) &&
      blockedByWaitText !== 'agent-approval-prompt'
    const newestPermissionAt = Math.max(
      explicitStatus?.status === 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
      terminal.waitBlockedAt ?? -1
    )
    const newestClearAt = Math.max(
      explicitStatus && explicitStatus.status !== 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
    )
    if (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) {
      return { handle, isRunningAgent: true, status: 'permission' }
    }
    if (
      blockedByWaitText &&
      (!liveTitleClearsBlockedText || lifecycle?.status === terminal.titleStatus) &&
      (blockedByWaitText === 'agent-approval-prompt' ||
        (newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt))
    ) {
      return { handle, isRunningAgent: true, status: 'permission' }
    }
    if (explicitStatus) {
      // Why: permission titles can linger after hooks report the agent resumed.
      // Fresh hook state is tighter, but current shell/management evidence wins.
      const isRunningAgent =
        !terminalTitleBlocksExplicitAgentStatus(terminal.title) &&
        !(await this.terminalHasShellForegroundProcess(handle, ptyId))
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return {
        handle,
        isRunningAgent,
        status: isRunningAgent ? explicitStatus.status : null
      }
    }
    if (terminal.titleStatus) {
      // Why: an OpenCode marker and a lone quarter-circle spinner (STA-4028) are activity,
      // not identity, so resolve both through the identity/foreground evidence path.
      if (
        isOpenCodeNativeTitle(terminal.title) ||
        isQuarterCircleSpinnerOnlyAgentTitle(terminal.title)
      ) {
        const isRunningAgent = await this.deps.isRunning(handle)
        this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
        return {
          handle,
          isRunningAgent,
          status: isRunningAgent ? terminal.titleStatus : null
        }
      }
      return { handle, isRunningAgent: true, status: terminal.titleStatus }
    }

    const isRunningAgent = await this.deps.isRunning(handle)
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    return { handle, isRunningAgent, status: null }
  }

  getPtyId(handle: string): string {
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_gone')
      }
      return pty.pty.ptyId
    }
    const { leaf } = this.deps.getLiveLeaf(handle)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    return leaf.ptyId
  }

  private assertTerminalAgentStatusPtyBinding(handle: string, expectedPtyId: string): void {
    if (this.getPtyId(handle) === expectedPtyId) {
      return
    }
    // Why: delayed process evidence belongs only to the PTY that started the
    // read, while callers still rely on the established stale-handle contract.
    throw new Error('terminal_handle_stale')
  }

  /** `displayClear` projects the snapshot as display shows it; evidence callers omit it. */
  getSnapshot(
    handle: string,
    expectedPtyId: string,
    displayClear: TitleDisplayClear | null = null
  ): RuntimeTerminalAgentStatusSnapshot {
    const live = this.deps.getLivePty(handle)
    if (live) {
      if (!live.pty.connected || live.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_not_writable')
      }
      const pty = { pty: getPtyDisplayRecord(live.pty, displayClear) }
      const primaryLeaf = this.deps.getPrimaryLeaf(live.pty.ptyId)
      const leaf = primaryLeaf ? getLeafDisplayRecord(primaryLeaf, displayClear) : null
      const leafTitle = leaf
        ? getLatestAgentCandidateTitleInfo(
            { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
            { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
          )
        : null
      const ptyTitle =
        leafTitle ??
        getLatestAgentCandidateTitleInfo(
          { title: pty.pty.title, updatedAt: pty.pty.titleUpdatedAt },
          { title: pty.pty.lastOscTitle, updatedAt: pty.pty.lastOscTitleAt }
        )
      const waitText = buildTerminalWaitText(
        pty.pty.tailBuffer,
        pty.pty.tailPartialLine,
        pty.pty.preview
      )
      return {
        waitText,
        waitBlockedAt: pty.pty.waitBlockedAt,
        title: ptyTitle?.title ?? null,
        titleStatus: ptyTitle
          ? detectAgentStatusFromTitle(ptyTitle.title)
          : pty.pty.lastAgentStatus,
        titleStatusIsLive: ptyTitle !== null
      }
    }

    const leaf = getLeafDisplayRecord(this.deps.getLiveLeaf(handle).leaf, displayClear)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    if (leaf.ptyId !== expectedPtyId) {
      throw new Error('terminal_not_writable')
    }
    const title = getLatestAgentCandidateTitleInfo(
      { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
      { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt },
      { title: this.deps.getTabTitle(leaf.tabId), updatedAt: 0 }
    )
    return {
      waitText: buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview),
      waitBlockedAt: leaf.waitBlockedAt,
      title: title?.title ?? null,
      titleStatus: title ? detectAgentStatusFromTitle(title.title) : leaf.lastAgentStatus,
      titleStatusIsLive: (title?.updatedAt ?? 0) > 0
    }
  }

  private async terminalHasShellForegroundProcess(handle: string, ptyId: string): Promise<boolean> {
    const controller = this.deps.getController()
    if (!controller) {
      return false
    }
    let foregroundProcess: string | null
    try {
      foregroundProcess = await controller.getForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return false
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    if (!foregroundProcess || !isShellProcess(foregroundProcess)) {
      return false
    }
    const confirmationController = this.deps.getController()
    if (!confirmationController?.confirmForegroundProcess) {
      return true
    }
    let confirmedProcess: string | null
    try {
      confirmedProcess = await confirmationController.confirmForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return true
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    // Why: hook identity is generic; strong provider evidence only needs to
    // prove that some recognized agent still owns this exact PTY.
    return recognizeAgentProcess(confirmedProcess) === null
  }
}
