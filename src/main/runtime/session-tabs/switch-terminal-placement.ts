import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-terminal-create-contract'
import type { WindowTabContent, WindowTabContentOutcome } from '../../../shared/window-tab-content'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  decideTabContent,
  type TabContent,
  type TabContentRef
} from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { loadChatTabLayout } from '../agent-session/agent-session-tab-layout'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './pty-backed-session-publication'
import { TerminalNotPlacedError } from './terminal-not-placed-error'

export type SwitchedTabContentRequest = {
  tabId: string
  expectSource: TabContentRef
  /** What the window shows; main's model takes `layout`. */
  window: WindowTabContent
  layout: TabContent
  focus: boolean
}

export abstract class OrcaRuntimeWithSwitchTerminalPlacement extends OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal {
  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    options?: LayoutCommandRunOptions
  ): Promise<LayoutApplyReply>

  /**
   * A switch's one layout write, in whichever store owns this workspace's layout (the window, or
   * main's model and a windowless host's saved layout): the tab holding just the switch's source
   * keeps its id and place and now holds the destination. Which tab, if any, is that owner's
   * answer, never assumed; `tabId` is main's best id for it. `decide` asks only which tab it would
   * be, changing nothing, so the chat's record names that tab before the write.
   */
  async setSwitchedTabContent(
    workspaceId: string,
    request: SwitchedTabContentRequest,
    decide = false
  ): Promise<WindowTabContentOutcome> {
    const windowOwnsLayout = !ORCA_LAYOUT_OWNER_IS_MAIN && this.getAvailableAuthoritativeWindow()
    if (windowOwnsLayout && this.notifier?.setTabContent) {
      return this.notifier.setTabContent({
        worktreeId: workspaceId,
        tabId: request.tabId,
        expectSource: request.expectSource,
        content: request.window,
        focus: request.focus,
        ...(decide ? { decide } : {})
      })
    }
    if (decide) {
      const session = this.getWorkspaceSessionForWorktree(workspaceId)
      return decideTabContent(
        session
          ? loadChatTabLayout(
              this.getWorkspaceSessionHostIdForWorktree(workspaceId),
              session,
              workspaceId
            ).loaded.layout.workspaces[workspaceId]
          : undefined,
        { ...request, content: request.layout }
      )
    }
    const reply = await this.applyLayoutCommand({
      type: 'setTabContent',
      workspace: workspaceId,
      tabId: request.tabId,
      expectSource: request.expectSource,
      content: request.layout
    })
    if (!reply.ok) {
      throw new TerminalNotPlacedError(reply.code)
    }
    return {
      retargeted: reply.result.retargeted === true,
      ...(reply.result.tabId ? { tabId: reply.result.tabId } : {})
    }
  }

  /**
   * A switch's layout change in commit order: the owner says which tab would take the destination,
   * changing nothing; `commit` records that tab in the chat-tab journal; then the owner changes the
   * tab, checking again. A refusal there (the user changed the tab meanwhile, or the window let the
   * request expire unapplied) changed nothing, and the caller opens the destination as an
   * ordinary tab. A failed decision or commit leaves the source as it was.
   */
  async switchTabContent(
    workspaceId: string,
    request: SwitchedTabContentRequest,
    commit: (tabId: string) => Promise<void>
  ): Promise<WindowTabContentOutcome> {
    const decided = await this.setSwitchedTabContent(workspaceId, request, true)
    if (!decided.retargeted || !decided.tabId) {
      return { retargeted: false }
    }
    await commit(decided.tabId)
    try {
      return await this.setSwitchedTabContent(workspaceId, { ...request, tabId: decided.tabId })
    } catch (error) {
      if (error instanceof TerminalNotPlacedError) {
        return { retargeted: false }
      }
      throw error
    }
  }

  /**
   * The terminal direction's write: the chat's tab now holds the parked terminal, once `commit`
   * took the chat out of the saved chat tabs. A tab that no longer holds just the chat (the user
   * closed it meanwhile) is left alone, and the terminal opens as an ordinary tab instead.
   */
  async placeSwitchTerminal(
    workspaceId: string,
    args: {
      terminal: RuntimeTerminalCreate
      chatSessionId: string
      /** The chat's tab as main knows it. */
      chatTabId: string
      activate: boolean
      focusWindow: boolean
      commit: () => Promise<void>
    }
  ): Promise<{ tabId: string; leafId: string; retargeted: boolean }> {
    const { terminal } = args
    const pty = terminal.ptyId ? this.ptysById.get(terminal.ptyId) : undefined
    const tabId = terminal.tabId
    const leafId =
      tabId && terminal.paneKey?.startsWith(`${tabId}:`)
        ? terminal.paneKey.slice(tabId.length + 1)
        : undefined
    if (!pty || !tabId || !leafId) {
      throw new TerminalNotPlacedError('terminal_handle_stale')
    }
    const adopt = {
      ptyId: pty.ptyId,
      ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {}),
      recordedPaneKey: `${tabId}:${leafId}`
    }
    const switched = await this.switchTabContent(
      workspaceId,
      {
        tabId: args.chatTabId,
        expectSource: { kind: 'agent-session', sessionId: args.chatSessionId },
        window: {
          kind: 'terminal',
          terminalId: tabId,
          leafId,
          ptyId: pty.ptyId,
          ...(terminal.title ? { title: terminal.title } : {}),
          ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {})
        },
        layout: { kind: 'terminal', terminalId: tabId, leafId, adopt },
        focus: args.focusWindow
      },
      args.commit
    )
    if (!switched.retargeted) {
      await this.placeOrdinaryTerminal(workspaceId, terminal, { tabId, leafId, adopt }, args)
    }
    this.publishPtyBackedMobileSessionTerminal(workspaceId, pty, {
      tabId,
      leafId,
      title: terminal.title,
      activate: args.activate,
      ...(switched.retargeted && switched.tabId ? { inTab: switched.tabId } : {})
    })
    return { tabId, leafId, retargeted: switched.retargeted }
  }

  private async placeOrdinaryTerminal(
    workspaceId: string,
    terminal: RuntimeTerminalCreate,
    pane: { tabId: string; leafId: string; adopt: { ptyId: string; incarnationId?: string } },
    args: { activate: boolean; focusWindow: boolean }
  ): Promise<void> {
    const windowOwnsLayout = !ORCA_LAYOUT_OWNER_IS_MAIN && this.getAvailableAuthoritativeWindow()
    if (windowOwnsLayout && this.notifier?.revealTerminalSession) {
      const launchAgent = this.ptysById.get(pane.adopt.ptyId)?.launchAgent
      await this.notifier.revealTerminalSession(workspaceId, {
        ptyId: pane.adopt.ptyId,
        title: terminal.title,
        ...(launchAgent ? { launchAgent } : {}),
        activate: args.activate,
        focus: args.focusWindow,
        tabId: pane.tabId,
        leafId: pane.leafId,
        ...(pane.adopt.incarnationId
          ? {
              expectedProcessIdentity: {
                terminalHandle: terminal.handle,
                incarnationId: pane.adopt.incarnationId
              }
            }
          : {})
      })
      return
    }
    const created = await this.applyLayoutCommand({
      type: 'createTerminalTab',
      workspace: workspaceId,
      tabId: pane.tabId,
      leafId: pane.leafId,
      adopt: pane.adopt
    })
    if (!created.ok) {
      throw new TerminalNotPlacedError(created.code)
    }
  }
}
