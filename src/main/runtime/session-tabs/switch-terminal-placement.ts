import { chatTabId } from '../agent-session/agent-session-tab-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-terminal-create-contract'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './pty-backed-session-publication'
import { TerminalNotPlacedError } from './terminal-not-placed-error'

export abstract class OrcaRuntimeWithSwitchTerminalPlacement extends OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal {
  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    options?: LayoutCommandRunOptions
  ): Promise<LayoutApplyReply>

  /**
   * A switch's one layout write: the parked terminal takes the chat tab's slot and the chat tab
   * goes, in whichever store owns this workspace's layout (the window, main's model, or the host
   * snapshot paired clients mirror). Nothing was shown before the terminal was real.
   */
  async placeSwitchTerminal(
    workspaceId: string,
    args: {
      terminal: RuntimeTerminalCreate
      chatSessionId: string
      /** The window's own id for the chat tab, when the switch came from a window. */
      windowTabId?: string
      activate: boolean
      focusWindow: boolean
    }
  ): Promise<{ tabId: string; leafId: string; replaced: boolean }> {
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
    const layoutTabId = chatTabId(args.chatSessionId)
    const snapshotTabId = `agent-session:${args.chatSessionId}`
    // Before the layout write: a window frame can name the terminal before main's own write does.
    const recorded = this.switchSlotAnchors.record(workspaceId, tabId, {
      replaces: { tabId: snapshotTabId }
    })
    // Whether the chat left is the layout owner's answer, never assumed.
    let replaced: boolean
    const windowOwnsLayout = !ORCA_LAYOUT_OWNER_IS_MAIN && this.getAvailableAuthoritativeWindow()
    if (windowOwnsLayout && this.notifier?.revealTerminalSession) {
      const windowTabId = args.windowTabId ?? layoutTabId
      const reply = await this.notifier.revealTerminalSession(workspaceId, {
        ptyId: pty.ptyId,
        title: terminal.title,
        ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
        activate: args.activate,
        focus: args.focusWindow,
        tabId,
        leafId,
        replaces: { tabId: windowTabId },
        ...(pty.incarnationId
          ? {
              expectedProcessIdentity: {
                terminalHandle: terminal.handle,
                incarnationId: pty.incarnationId
              }
            }
          : {})
      })
      replaced = reply?.closed?.includes(windowTabId) === true
    } else {
      // Main's layout model, or a windowless host's saved layout: the same one command.
      const reply = await this.applyLayoutCommand({
        type: 'createTerminalTab',
        workspace: workspaceId,
        tabId,
        leafId,
        adopt: {
          ptyId: pty.ptyId,
          ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {}),
          recordedPaneKey: `${tabId}:${leafId}`
        },
        replaces: { tabId: layoutTabId }
      })
      if (!reply.ok) {
        throw new TerminalNotPlacedError(reply.code)
      }
      replaced = reply.result.closed?.includes(layoutTabId) === true
    }
    // A retry finds the chat already gone (its first attempt replaced it); that anchor stays.
    if (!replaced && recorded) {
      this.switchSlotAnchors.forget(workspaceId, tabId)
    }
    this.publishPtyBackedMobileSessionTerminal(workspaceId, pty, {
      tabId,
      leafId,
      title: terminal.title,
      activate: args.activate,
      ...(replaced ? { replaces: snapshotTabId } : {})
    })
    return { tabId, leafId, replaced }
  }
}
