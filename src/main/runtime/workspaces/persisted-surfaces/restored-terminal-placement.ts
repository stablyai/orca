// Layout-owner build: what main itself restores at startup and window load, with or without a
// window: the live terminals no pane shows, and what the next startup reconnects.

import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { getSshConnectionManager } from '../../../ssh/targets/ssh-target-registry'
import {
  recordPtySurface,
  SURFACE_CLAIM_WITHOUT_STANDING
} from '../../pty-recorded-surface-topology'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'
import {
  placeUnshownLiveTerminals,
  placeUnshownLiveTerminalsBestEffort,
  type LiveTerminalPlacement
} from '../../terminal/adoption/unshown-live-terminal-placement'
import { onLocalPtyProviderRebound } from '../../../ipc/pty/provider/local-provider-rebound'
import {
  deriveShutdownReconnectFacts,
  type ShutdownReconnectFacts
} from '../../terminal/recovery/shutdown-reconnect-facts'
import { OrcaRuntimeWithAutomationOperations } from './automation-operations'
import {
  panesBoundToAnotherWorkspace,
  panesBoundToGoneLocalTerminals
} from '../../terminal/recovery/foreign-pane-bindings'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

/** The longest a workspace's first surface waits for main's placement pass. */
export const FIRST_SURFACE_PLACEMENT_WAIT_MS = 500

export abstract class OrcaRuntimeWithRestoredTerminalPlacement extends OrcaRuntimeWithAutomationOperations {
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>
  /** Shows a restored pane whose terminal is gone as sleeping, unless it already has a status. */
  protected abstract notePaneSleeping(paneKey: string): void

  private placementRun: Promise<LiveTerminalPlacement> | null = null
  private placementAgain = false
  /** The one pass running now, without the passes queued behind it. */
  private placementPass: Promise<LiveTerminalPlacement> | null = null
  private stopFollowingProviderRebinds: (() => void) | null = null

  /**
   * Layout-owner build: shows every live local terminal no pane shows. Runs at startup, window
   * load and client attach, and after the terminal service is replaced. One pass at a time: a call
   * during a pass runs one more pass after it, so a terminal seen late is still placed.
   */
  placeUnshownLiveTerminals(): Promise<LiveTerminalPlacement> {
    this.stopFollowingProviderRebinds ??= onLocalPtyProviderRebound(
      () => void placeUnshownLiveTerminalsBestEffort(this)
    )
    if (this.placementRun) {
      this.placementAgain = true
      return this.placementRun
    }
    const run = async (): Promise<LiveTerminalPlacement> => {
      let placement: LiveTerminalPlacement
      do {
        this.placementAgain = false
        this.placementPass = this.placeUnshownLiveTerminalsOnce()
        placement = await this.placementPass
      } while (this.placementAgain)
      return placement
    }
    this.placementRun = run().finally(() => {
      this.placementRun = null
      this.placementPass = null
    })
    return this.placementRun
  }

  /**
   * A workspace's first surface waits out the placement pass running when it arrives, not the
   * passes queued behind it: a live terminal that pass is placing is the workspace's tab, not room
   * for a fresh shell. At most FIRST_SURFACE_PLACEMENT_WAIT_MS, so opening a workspace stays quick;
   * a pass slower than that may leave an extra tab beside the restored terminal. Null when there
   * is nothing to wait for.
   */
  protected livePlacementSettledFor(command: WindowLayoutCommand): Promise<unknown> | null {
    const pass = this.placementPass
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || !('initial' in command) || !command.initial || !pass) {
      return null
    }
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_SURFACE_PLACEMENT_WAIT_MS)
    })
    return Promise.race([pass.catch(() => {}), cap]).finally(() => clearTimeout(timer))
  }

  private async placeUnshownLiveTerminalsOnce(): Promise<LiveTerminalPlacement> {
    await this.unbindPanesFromOtherWorkspacesTerminals()
    // A host that keeps no local terminals across restarts has none to find.
    if (!this.canRecoverPersistentLocalPtysFn()) {
      this.markDeadBoundPanesSleeping()
      return { placed: [], declined: [] }
    }
    let censusRead = false
    const placement = await placeUnshownLiveTerminals({
      refreshInventory: async () => {
        // Project-group folder workspaces are not in the worktree map; they resolve on their own.
        const workspaces = [
          ...(await this.getResolvedWorktreeMap()).values(),
          ...(this.store?.getFolderWorkspaces?.() ?? []).map((folder) =>
            this.folderWorkspaceToResolvedWorktree(folder)
          )
        ]
        const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
          workspaces,
          null,
          undefined,
          null
        )
        const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
        censusRead = inventory !== null
        return inventory && { ...inventory, workspaceIds }
      },
      ptys: () => this.ptysById.values(),
      // A window spawn holds its workspace's lock until its pane is recorded (spawn-run.ts).
      isStillBinding: (pty) =>
        this.terminalMutationLock.hasActiveSpawns(worktreeIdentityKey(pty.worktreeId)),
      hostIds: () => this.store?.getWorkspaceSessionHostIds?.() ?? [],
      session: (hostId) => this.store?.getWorkspaceSession?.(hostId),
      apply: (command) => this.applyLayoutCommand(command),
      recordPane: (ptyId, paneKey) => {
        const pty = this.ptysById.get(ptyId)
        const pane = parsePaneKey(paneKey)
        if (pty && pane) {
          // No graph standing: a window's graph that later shows otherwise still wins.
          recordPtySurface(pty, pane.tabId, paneKey, SURFACE_CLAIM_WITHOUT_STANDING)
        }
      }
    })
    // Only a census that answered proves a terminal gone; an unread one leaves panes as they are.
    if (censusRead) {
      this.markDeadBoundPanesSleeping()
    }
    return placement
  }

  /** Each local pane bound to a terminal the host no longer runs restores from it when started. */
  private markDeadBoundPanesSleeping(): void {
    const session = this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
    for (const paneKey of session
      ? panesBoundToGoneLocalTerminals(
          session,
          (ptyId) => this.ptysById.get(ptyId)?.connected === true
        )
      : []) {
      this.notePaneSleeping(paneKey)
    }
  }

  /** A pane bound to a terminal another workspace owns starts fresh; that terminal is placed home. */
  private async unbindPanesFromOtherWorkspacesTerminals(): Promise<void> {
    const store = this.store
    for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
      const session = store?.getWorkspaceSession?.(hostId)
      for (const binding of session ? panesBoundToAnotherWorkspace(session) : []) {
        const { worktreeId, ...pane } = binding
        await this.applyLayoutCommand({
          type: 'releasePaneTerminal',
          workspace: worktreeId,
          ...pane
        })
          .then((reply) => {
            if (!reply.ok) {
              console.warn('[layout] a pane kept another workspace terminal', reply.code)
            }
          })
          .catch((error: unknown) => {
            console.warn('[layout] a pane kept another workspace terminal', error)
          })
      }
    }
  }

  /** Layout-owner build: what the next startup reconnects for `session`, from main's own state. */
  shutdownReconnectFactsFor(
    session: WorkspaceSessionState,
    partition: ExecutionHostId
  ): ShutdownReconnectFacts {
    const store = this.store
    return deriveShutdownReconnectFacts(session, {
      isLiveLocalPty: (ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return pty?.connected === true && pty.connectionId === null
      },
      isKnownExited: (ptyId) => this.isPtyKnownExited(ptyId),
      sshStatusByTargetId: new Map(
        [...(getSshConnectionManager()?.getAllStates() ?? [])].map(([id, state]) => [
          id,
          state.status
        ])
      ),
      // The connection list is global: relay sessions in every partition name its targets.
      otherPartitions: () =>
        (store?.getWorkspaceSessionHostIds?.() ?? []).flatMap((hostId) => {
          const other = hostId === partition ? null : store?.getWorkspaceSession?.(hostId)
          return other ? [other] : []
        })
    })
  }
}
