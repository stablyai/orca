import { loadChatTabLayout, type ChatTabPlacement } from '../agent-session/agent-session-tab-layout'
import { windowListsTab } from '../terminal/surface/main-terminal-surfaces'
import { isOriginalTerminalHandle } from '../workspace-session-terminal-tab-retirement-identity'
import {
  matchesTerminalSurfaceCapture,
  type TerminalSurfaceCloseCapture
} from '../../../shared/terminal-tab-close'
import { OrcaRuntimeWithExplicitTerminalTabClose } from './explicit-terminal-tab-close'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import type { StoppedSwitchSourceScreen } from '../../../shared/stopped-switch-source'
import { withTimeout } from '../runtime-async-boundaries'

// Every frame naming the stopped pane carries its screen, so one is bounded in time and size.
const HELD_SCREEN_TIMEOUT_MS = 1_000
const HELD_SCREEN_MAX_CHARS = 256 * 1024

export abstract class OrcaRuntimeWithTerminalSwitchCloseCapture extends OrcaRuntimeWithExplicitTerminalTabClose {
  /** Whether a handle names a process a switch stopped and left: an attach is answered exited. */
  isStoppedSwitchSourceHandle(handle: string): boolean {
    const ptyId = this.handles.get(handle)?.ptyId
    return Boolean(
      ptyId &&
      this.stoppedSwitchSources.stoppedProcess(ptyId, this.ptysById.get(ptyId)?.incarnationId)
    )
  }

  /** The exact process's screen before its stop: none if it changed hands or can't be read in time. */
  private async heldSwitchSourceScreen(
    ptyId: string,
    incarnation: string
  ): Promise<StoppedSwitchSourceScreen | undefined> {
    const same = () => this.ptysById.get(ptyId)?.incarnationId === incarnation
    const image = same()
      ? await withTimeout(
          this.serializeHeadlessTerminalBuffer(ptyId, { scrollbackRows: 0 }).catch(() => null),
          HELD_SCREEN_TIMEOUT_MS,
          null
        )
      : null
    const { data, cols, rows, alternateScreen, scrollbackAnsi } = image ?? {}
    if (!data || !cols || !rows || !same()) {
      return undefined
    }
    if (data.length + (scrollbackAnsi?.length ?? 0) > HELD_SCREEN_MAX_CHARS) {
      return undefined
    }
    return {
      data,
      cols,
      rows,
      ...(alternateScreen ? { alternateScreen } : {}),
      ...(scrollbackAnsi ? { scrollbackAnsi } : {})
    }
  }

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
    // A `closing` stop keeps the pane's screen for a replace; it is owed one settlement.
    let keptStopped = false
    let stoppedSourceSettled = false
    let heldScreen: StoppedSwitchSourceScreen | undefined
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
        // Read before the stop holds the pane's presentation: what follows is the CLI's exit text.
        const screen = closing
          ? await this.heldSwitchSourceScreen(addressedPty, incarnation)
          : undefined
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
        keptStopped = closing
        heldScreen = screen
      },
      /**
       * Settles a `closing` stop: the window shows that exact pane exited unless it is gone. Sent
       * once, only after proof of the stop; a replace's chat names itself, so the window settles
       * only once that chat is there and its replace has had its pass.
       */
      settleStoppedSource: (switched?: {
        replacedBySessionId?: string
        agent?: AiVaultAgent
        providerSessionId?: string
      }) => {
        if (!keptStopped || stoppedSourceSettled) {
          return
        }
        stoppedSourceSettled = true
        // Nothing replaced the stopped pane: main's fact, which every viewer's frame carries. Its
        // screen lives and dies with it; a replace or an unproven stop never publishes one.
        const agent = switched?.replacedBySessionId ? undefined : switched?.agent
        const providerSessionId = switched?.providerSessionId
        const screen = agent && providerSessionId && heldScreen ? { screen: heldScreen } : {}
        heldScreen = undefined
        if (agent && providerSessionId) {
          this.stoppedSwitchSources.record(source, {
            ptyId: addressedPty,
            incarnationId: incarnation,
            agent,
            providerSessionId,
            ...screen
          })
          this.touchMobileSessionTabsForWorktree(source.worktreeId, { immediate: true })
        }
        this.notifier?.settleStoppedSwitchSource?.({
          worktreeId: source.worktreeId,
          tabId: source.tabId,
          leafId: source.leafId,
          ptyId: addressedPty,
          incarnationId: incarnation,
          ...(switched?.replacedBySessionId
            ? { replacedBySessionId: switched.replacedBySessionId }
            : {}),
          ...(switched
            ? { switched: switched.agent ? { agent: switched.agent, ...screen } : {} }
            : {})
        })
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
