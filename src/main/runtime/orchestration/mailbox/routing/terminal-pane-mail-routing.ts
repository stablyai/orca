import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'
import type { TerminalIdentityReadContext } from '../../../terminal/query/terminal-identity-read-context'
import { ptyRecordForPaneKey } from '../../../terminal/query/pty-pane-record'
import type { RuntimeTerminalAgentPresenceOptions } from '../../../terminal/query/runtime-terminal-agent-presence'
import { RuntimeSleptMailboxWakes } from './slept-mailbox-runtime'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import { detectAgentStatusFromTitle } from '../../../../../shared/agent-status/title/agent-title-status'
import { isClaudeManagementTitle } from '../../../../../shared/agent-status/title/agent-title-core'
import {
  GENERIC_PROCESS_NAME_AGENTS,
  recognizeAgentProcess
} from '../../../../../shared/agent-status/process/agent-process-recognition'
import { resolveStructuredWorkerAuthority } from '../../terminal-authority/structured-sessions/structured-worker-authority'
import type { StructuredPointerTarget } from '../structured-pointer/structured-mailbox-pointer-delivery'
import {
  structuredMailboxCustody,
  type StructuredMailboxCustody
} from './structured-session-mail-target'
import { resolveTerminalIdentityFromProbes } from '../../../terminal/identity/terminal-identity-probe'

export abstract class OrcaRuntimeWithGetPtyRecordForPaneKey extends RuntimeSleptMailboxWakes {
  protected terminalIdentitySources = () => ({
    handles: this.handles,
    sshTerminals: this.orchestrationCompatibilitySshTerminals,
    reverse: this.handleByPtyId,
    leaves: this.leaves,
    ptys: this.ptysById,
    capturePaneOf: () => this.captureTerminalPaneReader()
  })

  protected getPtyRecordForPaneKey(
    paneKey: string,
    context?: TerminalIdentityReadContext
  ): RuntimePtyWorktreeRecord | null {
    return ptyRecordForPaneKey(
      paneKey,
      {
        leaves: this.leaves,
        ptys: this.ptysById,
        leafKey: (tab, leaf) => this.getLeafKey(tab, leaf),
        capturePaneOf: () => this.captureTerminalPaneReader(),
        ...(!ORCA_LAYOUT_OWNER_IS_MAIN
          ? {
              paneOf: (pty: Parameters<typeof this.paneOfPty>[0]) => this.paneOfPty(pty),
              leavesForId: (id: string) => this.terminalIdentity.paneCandidates.leavesForId(id),
              ptysForPane: (pane: string) => this.terminalIdentity.paneCandidates.ptysForPane(pane)
            }
          : {})
      },
      context
    )
  }

  protected getPaneKeyForTerminalHandle(
    handle: string,
    context?: TerminalIdentityReadContext
  ): string | null {
    const pty = this.getLivePtyForHandle(handle, context)?.pty
    const livePaneKey = (context && pty ? context.paneOf(pty) : this.paneOfPty(pty)).paneKey
    if (livePaneKey) {
      return livePaneKey
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId || !isTerminalLeafId(record.leafId)) {
      return null
    }
    return makePaneKey(record.tabId, record.leafId)
  }

  getTerminalWorktreeIdForHandle(
    handle: string,
    context?: TerminalIdentityReadContext
  ): string | null {
    const livePty = this.getLivePtyForHandle(handle, context)
    if (livePty?.pty.worktreeId) {
      return livePty.pty.worktreeId
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      return null
    }
    return record.worktreeId
  }

  protected setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void {
    const trimmed = title?.trim()
    if (!trimmed) {
      return
    }
    if (isClaudeManagementTitle(trimmed)) {
      pty.managementTitle = trimmed
      pty.managementTitleAt = observedAt
      return
    }
    if (
      detectAgentStatusFromTitle(trimmed) !== null &&
      observedAt >= (pty.managementTitleAt ?? -1)
    ) {
      pty.managementTitle = null
      pty.managementTitleAt = null
    }
  }

  protected nextTitleObservationSequence(): number {
    this.titleObservationSequence += 1
    return this.titleObservationSequence
  }

  // Agent titles prove presence, but Claude management titles do not imply task activity.
  async isTerminalRunningAgent(
    handle: string,
    options?: RuntimeTerminalAgentPresenceOptions
  ): Promise<boolean> {
    return this.terminalAgentPresence.isRunning(handle, options)
  }

  async isTerminalRunningSettledPromptAgent(handle: string): Promise<boolean> {
    try {
      const { pty: trackedPty } = this.getTerminalPtyForHandle(handle)
      const { ptyId } = trackedPty
      if (!this.ptyController) {
        return false
      }
      let foregroundProcess = await this.ptyController.getForegroundProcess(ptyId)
      let agent = recognizeAgentProcess(foregroundProcess)?.agent
      // Confirm unfamiliar foreground names (macOS Claude p_comm can be 2.1.258) before downgrading atomic paste to truncating unframed chunks.
      if (agent === undefined && this.ptyController.confirmForegroundProcess) {
        foregroundProcess = await this.ptyController.confirmForegroundProcess(ptyId)
        agent = recognizeAgentProcess(foregroundProcess)?.agent
      }
      // Why every agent: unframed keystrokes can open Pi's `#` completion or answer a trust menu; Dispatch already frames them all.
      // A generic process name alone could be an ordinary tool, so those agents need title or hook evidence.
      const proof = agent && GENERIC_PROCESS_NAME_AGENTS.has(agent) ? null : foregroundProcess
      const presence = { retryForegroundWrappers: false, foregroundProcess: proof }
      if (agent === undefined || !(await this.isTerminalRunningAgent(handle, presence))) {
        return false
      }
      trackedPty.foregroundAgent = agent
      return true
    } catch {
      return false
    }
  }

  /** Read-only live-agent identity in either lane, without terminal.show's writable-looking pane payload. */
  resolveTerminalIdentity(handle: string) {
    return resolveTerminalIdentityFromProbes(handle, {
      isLiveStructuredWorker: () =>
        Boolean(resolveStructuredWorkerAuthority(handle, this._orchestrationDb)),
      hasLivePty: () => Boolean(this.getLivePtyForHandle(handle)),
      assertLiveLeaf: () => {
        this.getLiveLeafForHandle(handle)
      }
    })
  }

  deliverPendingMessagesForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.orchestrationMailboxNotifications.deliverForHandle(handle, reservedTypes)
  }

  /** Resolve every structured-owned mailbox here; declining Run or direct mail would leave both delivery lanes refusing it. */
  protected resolveStructuredMailboxTarget(mailboxHandle: string): StructuredPointerTarget | null {
    const custody = this.structuredMailboxCustody(mailboxHandle)
    return typeof custody === 'object' ? custody : null
  }

  /** Who holds a mailbox, from durable facts: the chat its mail reaches, someone else, or unverifiable now. */
  protected structuredMailboxCustody(mailboxHandle: string): StructuredMailboxCustody {
    return structuredMailboxCustody(mailboxHandle, this._orchestrationDb)
  }

  protected scheduleRestoredMessageRepoints(): void {
    let handles: Set<string>
    try {
      const db = this._orchestrationDb
      // Pointer-phase rows are excluded from the undelivered scan, so they need their own.
      handles = new Set([
        ...(db?.getUndeliveredUnreadMailboxHandles?.() ?? []),
        ...(db?.getPendingMailboxPointerHandles?.() ?? []),
        // Delivered mail a chat still holds: what became of it is read on this pass.
        ...(db?.getStructuredMailSendMailboxes?.() ?? [])
      ])
    } catch (error) {
      console.warn('[orchestration] failed to scan restored mailboxes', error)
      return
    }
    for (const handle of handles) {
      try {
        if (handle.startsWith('run:') || handle.startsWith('dispatch:')) {
          this.mailPointerRepointScheduler.schedule(handle)
          continue
        }
        const routed = this.orchestrationMailboxOwner.routeDetachedDirectMessages(handle)
        for (const mailbox of routed.mailboxes) {
          this.mailPointerRepointScheduler.schedule(mailbox.mailboxHandle)
        }
        if (!routed.hasMore) {
          this.mailPointerRepointScheduler.schedule(handle)
        }
      } catch (error) {
        console.warn(`[orchestration] failed to restore mailbox ${handle}`, error)
        this.mailPointerRepointScheduler.schedule(handle)
      }
    }
  }

  protected repointPendingMessagesForHandle(handle: string): void {
    try {
      const terminal = this.orchestrationMailboxDeliveryTarget.resolveTerminal(handle)
      if (terminal) {
        this.orchestrationMailboxPointerDelivery.restoreUncertainMail(terminal.ptyId)
      }
      if (terminal && this.orchestrationMailboxPointerDelivery.isForegroundHeld(terminal.ptyId)) {
        this.armDeliveryRecheck(terminal.ptyId)
        return
      }
      this.deliverPendingMessagesForHandle(handle)
    } catch {
      // The unref'd repair can outlive a test/runtime-owned database during shutdown.
    }
  }
}
