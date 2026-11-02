import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-terminal-create-contract'
import type { WindowTabContent, WindowTabContentOutcome } from '../../../shared/window-tab-content'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  decideTabContent,
  tabContentRef,
  type TabContent,
  type TabContentRef
} from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { chatTabIdAmong, loadChatTabLayout } from '../agent-session/agent-session-tab-layout'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import { logicalTabIdOf } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './pty-backed-session-publication'
import { TerminalNotPlacedError } from './terminal-not-placed-error'

export type SwitchedTabContentRequest = {
  /** The tab, once decided; deciding without one finds the tab holding the source. */
  tabId?: string
  /** Read just `tabId` (no search by content). */
  exact?: boolean
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
   * main's model and a windowless host's saved layout): the decided tab, holding just the
   * switch's source, keeps its id and place and now holds the destination. Which tab, if any, is
   * that owner's answer, never assumed. `decide` asks only which tab it would be (or, `exact`, what
   * one tab holds now), changing nothing, so the chat's record names that tab before the write.
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
        ...(request.tabId !== undefined ? { tabId: request.tabId } : {}),
        expectSource: request.expectSource,
        content: request.window,
        focus: request.focus,
        ...(decide ? { decide } : {}),
        ...(request.exact ? { exact: true } : {})
      })
    }
    if (decide) {
      return decideTabContent(
        this.ownerLayoutWorkspace(workspaceId),
        { ...request, content: request.layout },
        request.exact === true
      )
    }
    if (request.tabId === undefined) {
      throw new TerminalNotPlacedError('tab_not_decided')
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

  /** This workspace's layout as its owner has it when that owner is main: main's own model, or a
   *  windowless host's saved layout. */
  protected ownerLayoutWorkspace(workspaceId: string): WorkspaceLayout | undefined {
    const live = ORCA_LAYOUT_OWNER_IS_MAIN ? this.mainLayoutWorkspace(workspaceId) : undefined
    if (live) {
      return live
    }
    const session = this.getWorkspaceSessionForWorktree(workspaceId)
    return session
      ? loadChatTabLayout(
          this.getWorkspaceSessionHostIdForWorktree(workspaceId),
          session,
          workspaceId
        ).loaded.layout.workspaces[workspaceId]
      : undefined
  }

  protected abstract mainLayoutWorkspace(worktreeId: string): WorkspaceLayout | undefined

  /** The tab holding just this content, asked of the layout owner (never the published tab
   *  graph, which can trail it). */
  async ownerTabHolding(
    workspaceId: string,
    content: Pick<SwitchedTabContentRequest, 'window' | 'layout'>
  ): Promise<string | undefined> {
    const held = await this.setSwitchedTabContent(
      workspaceId,
      { ...content, expectSource: tabContentRef(content.layout), focus: false },
      true
    )
    return held.retargeted ? held.tabId : undefined
  }

  /**
   * The tab a switch's chat opens in when it doesn't fill the switched tab: the tab already holding
   * the chat, else its usual id, else the next free one, as the layout owner has its tabs (a
   * window lists its own tabs; main follows the same rule, `mirroredTabContainers`).
   */
  switchChatTabId(workspaceId: string, sessionId: string): string {
    const shown = (this.mobileSessionTabsByWorktree.get(workspaceId)?.tabs ?? []).map((row) => ({
      id: logicalTabIdOf(row),
      holds: row.type === 'agent-session' && row.sessionId === sessionId
    }))
    const tabs = [
      ...(this.ownerLayoutWorkspace(workspaceId)?.tabs ?? []).map((tab) => ({
        id: tab.id,
        holds: tab.kind === 'agent-session' && tab.entityId === sessionId
      })),
      ...(ORCA_LAYOUT_OWNER_IS_MAIN ? [] : shown)
    ]
    return chatTabIdAmong(tabs, sessionId)
  }

  /**
   * A switch's layout change in commit order: the owner says which tab would take the
   * destination, changing nothing; `commit` records that tab in the chat-tab journal; then the
   * owner changes exactly that tab, checking again. A refusal there (the user changed the tab
   * meanwhile, or the request reached the window past its deadline) changed nothing, and the
   * caller opens the destination as an ordinary tab. A failed decision or commit leaves the source
   * as it was.
   *
   * After the commit an answer that never came is unknown, never a refusal: the tab is asked again,
   * bound to it, unless `current` says a later close or switch superseded this one. Already
   * holding the destination is done, still holding the source applies it now, anything else is
   * the ordinary fallback. With the owner still silent, the committed tab stands, and the owner's
   * startup puts the destination there.
   */
  async switchTabContent(
    workspaceId: string,
    request: SwitchedTabContentRequest,
    commit: (tabId: string) => Promise<void>,
    current: () => boolean = () => true
  ): Promise<WindowTabContentOutcome> {
    const decided = await this.setSwitchedTabContent(workspaceId, request, true)
    if (!decided.retargeted || !decided.tabId) {
      return { retargeted: false }
    }
    await commit(decided.tabId)
    const bound = { ...request, tabId: decided.tabId }
    try {
      return await this.setSwitchedTabContent(workspaceId, bound)
    } catch {
      if (!current()) {
        return { retargeted: true, tabId: decided.tabId }
      }
    }
    try {
      return await this.setSwitchedTabContent(workspaceId, bound)
    } catch {
      return { retargeted: true, tabId: decided.tabId }
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
      /** The chat's tab as its owner named it; none (a retry whose chat already left) finds the
       *  tab holding the terminal. */
      chatTabId?: string
      /** False once a later switch or close superseded this placement. */
      current?: () => boolean
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
    const content = {
      window: {
        kind: 'terminal' as const,
        terminalId: tabId,
        leafId,
        ptyId: pty.ptyId,
        ...(terminal.title ? { title: terminal.title } : {}),
        ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {})
      },
      layout: { kind: 'terminal' as const, terminalId: tabId, leafId, adopt }
    }
    const switched = await this.switchTabContent(
      workspaceId,
      {
        tabId: args.chatTabId ?? (await this.ownerTabHolding(workspaceId, content)),
        expectSource: { kind: 'agent-session', sessionId: args.chatSessionId },
        ...content,
        focus: args.focusWindow
      },
      args.commit,
      args.current
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
