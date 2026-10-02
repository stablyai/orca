import {
  detectAgentStatusFromTitle,
  isOpenCodeNativeTitle,
  isShellProcess,
  isQuarterCircleSpinnerOnlyAgentTitle,
  type AgentStatus
} from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { shareCompatibleTitleIdentityGroup } from '../../shared/agent-title-owner'
import { resolveExplicitTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'
import { ptyForegroundIsShell } from './pty-shell-foreground-evidence'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  terminalTitleBlocksExplicitAgentStatus,
  getLatestAgentCandidateTitleInfo,
  ptyTitleIsRestored
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
  titleIsRestored: boolean
}

type Dependencies = {
  getController(): RuntimePtyController | null
  getLivePty(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  getLiveLeaf(handle: string): { leaf: RuntimeLeafRecord }
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTrackedPty(ptyId: string): RuntimePtyWorktreeRecord | null
  getTabTitle(tabId: string): string | null
  getExplicitStatus(
    handle: string
  ): { status: NonNullable<RuntimeTerminalAgentStatus['status']>; updatedAt: number } | null
  getLifecycleStatus(
    ptyId: string
  ): { status: AgentStatus | null; updatedAt: number } | null | undefined
  isRunning(handle: string): Promise<boolean>
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

  private async readStatus(handle: string, retriesLeft = 1): Promise<RuntimeTerminalAgentStatus> {
    const ptyId = this.getPtyId(handle)
    const terminal = this.getSnapshot(handle, ptyId)
    const explicitStatus = this.deps.getExplicitStatus(handle)
    const lifecycle = this.deps.getLifecycleStatus(ptyId)
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
    // Why: a restored title can outlive its agent, so it proves permission only once verified below.
    if (
      terminal.titleStatus === 'permission' &&
      terminal.titleStatusIsLive &&
      !terminal.titleIsRestored
    ) {
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
      // not identity, and a restored title can outlive its agent, so resolve all three
      // through the identity/foreground evidence path.
      if (
        isOpenCodeNativeTitle(terminal.title) ||
        isQuarterCircleSpinnerOnlyAgentTitle(terminal.title) ||
        terminal.titleIsRestored
      ) {
        const isRunningAgent = await this.deps.isRunning(handle)
        // Why: an exited agent's restored title can sit over a different agent that set none.
        const titleOwnsAgent =
          isRunningAgent &&
          (!terminal.titleIsRestored ||
            (await this.foregroundAgentMatchesTitle(
              ptyId,
              terminal.title,
              terminal.titleStatus === 'permission'
            )))
        this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
        // Why: a live title can land during the awaits above and supersede the one read here.
        if (retriesLeft > 0 && titleObservationChanged(terminal, this.getSnapshot(handle, ptyId))) {
          return this.readStatus(handle, retriesLeft - 1)
        }
        return {
          handle,
          isRunningAgent,
          status: titleOwnsAgent ? terminal.titleStatus : null
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

  getSnapshot(handle: string, expectedPtyId: string): RuntimeTerminalAgentStatusSnapshot {
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (!pty.pty.connected || pty.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_not_writable')
      }
      const leaf = this.deps.getPrimaryLeaf(pty.pty.ptyId)
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
        titleStatusIsLive: ptyTitle !== null,
        // Why the PTY record: only it knows whether a title was ever observed live, and a leaf
        // bound to an adopted session inherits the restored title without that knowledge.
        titleIsRestored: ptyTitleIsRestored(pty.pty, ptyTitle?.title ?? null)
      }
    }

    const { leaf } = this.deps.getLiveLeaf(handle)
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
    const trackedPty = this.deps.getTrackedPty(leaf.ptyId)
    return {
      waitText: buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview),
      waitBlockedAt: leaf.waitBlockedAt,
      title: title?.title ?? null,
      titleStatus: title ? detectAgentStatusFromTitle(title.title) : leaf.lastAgentStatus,
      titleStatusIsLive: (title?.updatedAt ?? 0) > 0,
      titleIsRestored: trackedPty !== null && ptyTitleIsRestored(trackedPty, title?.title ?? null)
    }
  }

  /**
   * Whether the foreground agent can own a restored title: a recognized agent outside the title's
   * identity group contradicts it, and missing evidence keeps it unless `requireOwner` is set.
   * Why `requireOwner` for permission: a stale prompt can draw an approval typed into whatever runs
   * now, while losing a restored one only leaves the status unknown until live evidence arrives.
   */
  private async foregroundAgentMatchesTitle(
    ptyId: string,
    title: string | null,
    requireOwner: boolean
  ): Promise<boolean> {
    const titleAgent = title ? resolveExplicitTerminalTitleAgentType(title) : null
    const controller = this.deps.getController()
    if (!titleAgent || !controller) {
      return !requireOwner
    }
    let foregroundAgent: TuiAgent | null
    try {
      const foreground = await controller.getForegroundProcess(ptyId)
      // Why: behind a cached shell, presence accepts an agent only from fresh evidence; so must this.
      const evidence =
        foreground && isShellProcess(foreground)
          ? await controller.confirmForegroundProcess?.(ptyId)
          : foreground
      foregroundAgent = recognizeAgentProcess(evidence)?.agent ?? null
    } catch {
      return !requireOwner
    }
    if (foregroundAgent === null) {
      return !requireOwner
    }
    return shareCompatibleTitleIdentityGroup(titleAgent, foregroundAgent)
  }

  private async terminalHasShellForegroundProcess(handle: string, ptyId: string): Promise<boolean> {
    const controller = this.deps.getController()
    if (!controller) {
      return false
    }
    return ptyForegroundIsShell({
      readForegroundProcess: () => controller.getForegroundProcess(ptyId),
      confirmForegroundProcess: () =>
        this.deps.getController()?.confirmForegroundProcess?.(ptyId) ?? null,
      afterRead: () => this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    })
  }
}

function titleObservationChanged(
  before: RuntimeTerminalAgentStatusSnapshot,
  after: RuntimeTerminalAgentStatusSnapshot
): boolean {
  return (
    before.title !== after.title ||
    before.titleStatus !== after.titleStatus ||
    before.titleIsRestored !== after.titleIsRestored
  )
}
