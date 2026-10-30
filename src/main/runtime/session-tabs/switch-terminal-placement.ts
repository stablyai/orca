import { chatTabId } from '../agent-session/agent-session-tab-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-terminal-create-contract'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './pty-backed-session-publication'

export abstract class OrcaRuntimeWithSwitchTerminalPlacement extends OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal {
  protected abstract getAvailableAuthoritativeWindow(): unknown
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
      throw new Error('terminal_handle_stale')
    }
    const layoutTabId = chatTabId(args.chatSessionId)
    let replaced = false
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const reply = await this.applyLayoutCommand({
        type: 'createTerminalTab',
        workspace: workspaceId,
        tabId,
        leafId,
        adopt: {
          ptyId: pty.ptyId,
          ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {})
        },
        replaces: { tabId: layoutTabId }
      })
      if (!reply.ok) {
        throw new Error(reply.code)
      }
      replaced = reply.result.closed?.includes(layoutTabId) === true
    } else if (this.getAvailableAuthoritativeWindow() && this.notifier?.revealTerminalSession) {
      const windowTabId = args.windowTabId ?? layoutTabId
      await this.notifier.revealTerminalSession(workspaceId, {
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
      replaced = true
    }
    const snapshotTabId = `agent-session:${args.chatSessionId}`
    const listed = this.mobileSessionTabsByWorktree
      .get(workspaceId)
      ?.tabGroups?.some((group) => group.tabOrder.includes(snapshotTabId))
    this.publishPtyBackedMobileSessionTerminal(workspaceId, pty, {
      tabId,
      leafId,
      title: terminal.title,
      activate: args.activate,
      replaces: snapshotTabId
    })
    return { tabId, leafId, replaced: replaced || listed === true }
  }
}
