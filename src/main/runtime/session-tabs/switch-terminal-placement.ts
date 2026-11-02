import { randomUUID } from 'node:crypto'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { AgentType } from '../../../shared/agent-status-types'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-terminal-create-contract'
import type { WindowTabContent, WindowTabContentOutcome } from '../../../shared/window-tab-content'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  chatTabIdAmong,
  decideTabContent,
  tabContentRef,
  type TabContent,
  type TabContentRef
} from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { loadChatTabLayout } from '../agent-session/agent-session-tab-layout'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './pty-backed-session-publication'
import { TerminalNotPlacedError } from './terminal-not-placed-error'

export type SwitchedTabContentRequest = {
  /** The tab, once decided; deciding without one finds the tab holding the source. */
  tabId?: string
  /** Read just `tabId` (no search by content). */
  exact?: boolean
  /** The switch, and the window page that granted it its tab (`WindowTabContentRequest`). */
  operation?: string
  page?: string
  expectSource: TabContentRef
  /** What the window shows; main's model takes `layout`. */
  window: WindowTabContent
  layout: TabContent
  focus: boolean
}

/** How a committed switch's one change settled (`switchTabContent`). */
export type SwitchSettlement =
  /** The decided tab holds the destination, and the switch is still the chat's current one. */
  | { kind: 'applied'; tabId: string }
  /** Nothing changed (no tab decided, or the owner refused before applying); `destination` is
   *  where the owner would open the chat instead. */
  | { kind: 'refused'; committed: boolean; destination?: string }
  /** It applied, and a later close or switch has changed that tab or the chat's record since. */
  | { kind: 'superseded'; tabId: string }
  /** No answer: the committed record stands until the owner's startup or a late answer. */
  | { kind: 'unknown'; tabId: string }

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
    decide = false,
    late?: (outcome: WindowTabContentOutcome) => void
  ): Promise<WindowTabContentOutcome> {
    const windowOwnsLayout = !ORCA_LAYOUT_OWNER_IS_MAIN && this.getAvailableAuthoritativeWindow()
    if (windowOwnsLayout && this.notifier?.setTabContent) {
      return this.notifier.setTabContent(
        {
          worktreeId: workspaceId,
          ...(request.tabId !== undefined ? { tabId: request.tabId } : {}),
          expectSource: request.expectSource,
          content: request.window,
          focus: request.focus,
          ...(decide ? { decide } : {}),
          ...(request.exact ? { exact: true } : {}),
          ...(request.operation ? { operation: request.operation } : {}),
          ...(request.page ? { page: request.page } : {})
        },
        late
      )
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
   * the chat, else its usual id, else the next free one, as the layout owner has its tabs now. A
   * window answers for itself (its tabs can be newer than main's copy); main reads its own model.
   */
  async switchChatTabId(workspaceId: string, sessionId: string, agent: AgentType): Promise<string> {
    const windowOwnsLayout = !ORCA_LAYOUT_OWNER_IS_MAIN && this.getAvailableAuthoritativeWindow()
    if (windowOwnsLayout && this.notifier?.setTabContent) {
      const chat = { kind: 'agent-session' as const, sessionId, agent }
      const asked = await this.setSwitchedTabContent(
        workspaceId,
        { window: chat, layout: chat, expectSource: chat, focus: false },
        true
      ).catch(() => undefined)
      if (asked?.tabId) {
        return asked.tabId
      }
    }
    return chatTabIdAmong(
      (this.ownerLayoutWorkspace(workspaceId)?.tabs ?? []).map((tab) => ({
        id: tab.id,
        holds: tab.kind === 'agent-session' && tab.entityId === sessionId
      })),
      sessionId
    )
  }

  /**
   * A switch's layout change in commit order: the owner decides which tab would take the
   * destination, granting this switch that tab and changing nothing; `commit` records it in the
   * chat-tab journal and returns whether the switch is still the chat's current one; then the
   * owner changes exactly that tab, at most once, with no deadline on the change itself. A failed
   * decision or commit leaves the source as it was.
   *
   * The owner's answer, not time, settles it: applied (and current), refused before it applied
   * (the user changed the tab meanwhile: the caller opens the destination where the owner says),
   * applied then superseded by a later close or switch (nothing more happens), or unknown (the
   * committed record stands; the owner's startup or a `late` answer settles the display).
   */
  async switchTabContent(
    workspaceId: string,
    request: SwitchedTabContentRequest,
    commit: (tabId: string) => Promise<() => boolean>,
    late?: (settlement: SwitchSettlement) => void
  ): Promise<SwitchSettlement> {
    const operation = randomUUID()
    const decided = await this.setSwitchedTabContent(workspaceId, { ...request, operation }, true)
    if (!decided.retargeted || !decided.tabId) {
      return { kind: 'refused', committed: false }
    }
    const tabId = decided.tabId
    const current = await commit(tabId)
    const settled = (outcome: WindowTabContentOutcome): SwitchSettlement =>
      !outcome.retargeted
        ? {
            kind: 'refused',
            committed: true,
            ...(outcome.tabId ? { destination: outcome.tabId } : {})
          }
        : outcome.superseded || !current()
          ? { kind: 'superseded', tabId }
          : { kind: 'applied', tabId }
    try {
      return settled(
        await this.setSwitchedTabContent(
          workspaceId,
          { ...request, tabId, operation, ...(decided.page ? { page: decided.page } : {}) },
          false,
          late && ((outcome) => late(settled(outcome)))
        )
      )
    } catch (error) {
      if (error instanceof TerminalNotPlacedError) {
        return { kind: 'refused', committed: true }
      }
      return { kind: 'unknown', tabId }
    }
  }

  /**
   * The terminal direction's write: the chat's tab now holds the parked terminal, once `commit`
   * took the chat out of the saved chat tabs. A tab that no longer holds just the chat (the user
   * closed it meanwhile) is left alone, and the terminal opens as an ordinary tab instead. Only a
   * settlement while the switch is current publishes: a later close or switch leaves it unshown.
   */
  async placeSwitchTerminal(
    workspaceId: string,
    args: {
      terminal: RuntimeTerminalCreate
      chatSessionId: string
      /** The chat's tab as its owner named it; none (a retry whose chat already left) finds the
       *  tab holding the terminal. */
      chatTabId?: string
      activate: boolean
      focusWindow: boolean
      /** Records the switch; returns whether it is still the chat's current one. */
      commit: () => Promise<() => boolean>
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
    const publish = (inTab?: string): void =>
      this.publishPtyBackedMobileSessionTerminal(workspaceId, pty, {
        tabId,
        leafId,
        title: terminal.title,
        activate: args.activate,
        ...(inTab ? { inTab } : {})
      })
    const settle = async (settlement: SwitchSettlement): Promise<void> => {
      if (settlement.kind === 'applied') {
        publish(settlement.tabId)
      } else if (settlement.kind === 'refused') {
        await this.placeOrdinaryTerminal(workspaceId, terminal, { tabId, leafId, adopt }, args)
        publish()
      }
    }
    let current = (): boolean => true
    const switched = await this.switchTabContent(
      workspaceId,
      {
        tabId: args.chatTabId ?? (await this.ownerTabHolding(workspaceId, content)),
        expectSource: { kind: 'agent-session', sessionId: args.chatSessionId },
        ...content,
        focus: args.focusWindow
      },
      async () => (current = await args.commit()),
      (late) => {
        if (current()) {
          settle(late).catch((error: unknown) =>
            console.warn('[switch] a late terminal placement failed:', error)
          )
        }
      }
    )
    await settle(switched)
    return { tabId, leafId, retargeted: switched.kind !== 'refused' }
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
