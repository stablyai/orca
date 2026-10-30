import { loadChatTabLayout, type ChatTabPlacement } from '../agent-session/agent-session-tab-layout'
import { windowListsTab } from '../terminal/surface/main-terminal-surfaces'
import { isOriginalTerminalHandle } from '../workspace-session-terminal-tab-retirement-identity'
import {
  matchesTerminalSurfaceCapture,
  type TerminalSurfaceCloseCapture
} from '../../../shared/terminal-tab-close'
import { OrcaRuntimeWithExplicitTerminalTabClose } from './explicit-terminal-tab-close'
export abstract class OrcaRuntimeWithTerminalSwitchCloseCapture extends OrcaRuntimeWithExplicitTerminalTabClose {
  captureTerminalSwitchClose(
    handle: string,
    incarnation: string,
    originalPresentation: TerminalSurfaceCloseCapture,
    replacement = true
  ) {
    const source = originalPresentation.identity
    const record = this.handles.get(handle)
    const currentPty = source.ptyId ? this.ptysById.get(source.ptyId) : null
    const leaf = this.leaves.get(this.getLeafKey(source.tabId, source.leafId))
    if (
      !source.ptyId ||
      !incarnation ||
      !isOriginalTerminalHandle({
        runtimeId: this.runtimeId,
        record,
        currentPty,
        paneOfPty: (current) => this.paneOfPty(current),
        leaf,
        source,
        incarnation
      }) ||
      !matchesTerminalSurfaceCapture(
        originalPresentation,
        this.getWorkspaceSessionHostIdsForTab(source.worktreeId, source.tabId),
        (hostId) => this.store?.getWorkspaceSession?.(hostId)
      )
    ) {
      throw new Error('terminal_handle_stale')
    }
    const readPlacement = (): ChatTabPlacement | undefined => {
      const session = this.getWorkspaceSessionForWorktree(source.worktreeId)
      if (!session) {
        return undefined
      }
      const { loaded } = loadChatTabLayout(
        this.getWorkspaceSessionHostIdForWorktree(source.worktreeId),
        session,
        source.worktreeId
      )
      const group = loaded.layout.workspaces[source.worktreeId]?.groups.find((row) =>
        row.tabOrder.includes(source.tabId)
      )
      return group
        ? {
            groupId: group.id,
            afterTabId: source.tabId,
            index: group.tabOrder.indexOf(source.tabId)
          }
        : undefined
    }
    const originalPlacement = readPlacement()
    const addressedPty = source.ptyId
    const rendererOwnsPresentation = windowListsTab(this, this.tabs, source.tabId)
    const proof = {
      parentTabId: source.tabId,
      leafId: source.leafId,
      ptyId: source.ptyId,
      terminal: handle,
      incarnationId: incarnation
    }
    /** Whether retiring this pane retires its tab: only then may the chat take the tab's slot. */
    const wholeTab = () => {
      const resolution = this.resolveTerminalCloseTarget(source.worktreeId, {
        kind: 'pane',
        tabId: source.tabId,
        leafId: source.leafId
      })
      return resolution === 'tab' || resolution === 'last-pane'
    }
    return {
      source,
      wholeTab,
      placement: () =>
        matchesTerminalSurfaceCapture(
          originalPresentation,
          this.getWorkspaceSessionHostIdsForTab(source.worktreeId, source.tabId),
          (hostId) => this.store?.getWorkspaceSession?.(hostId)
        )
          ? (readPlacement() ?? originalPlacement)
          : undefined,
      /** `closing` keeps the exited pane shown for the write that removes its tab; without one
       *  coming (a split sibling keeps the tab), the pane retires on exit as any pane does. */
      stop: async (closing = wholeTab()) => {
        const stop = await this.stopExplicitlyClosedTabPtys(
          [addressedPty],
          addressedPty,
          incarnation,
          {
            closing
          }
        )
        if (!stop.stopped) {
          throw new Error('terminal_close_unverifiable')
        }
      },
      /** Retires the pane's bookkeeping; its presentation too, unless a replace or its exit already did. */
      retire: async (presentationRetired = false) => {
        const outcome = await this.closeMobileSessionTab(`id:${source.worktreeId}`, source.tabId, {
          originalPresentation,
          rendererOwnsPresentation,
          localPtyTeardownOwnedExternally: true,
          force: replacement,
          retirementProofs: [proof],
          presentationRetired
        })
        if (outcome.refused) {
          throw new Error('terminal_pane_close_failed')
        }
        this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
        return this.describeTerminalClose(handle, source.tabId, source.ptyId, { stopped: true })
      }
    }
  }
}
