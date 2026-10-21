// Layout-owner build: what main itself restores at startup and window load, with or without a
// window: the live terminals no pane shows, and what the next startup reconnects.

import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { worktreeIdentityKey, worktreeIdsEqual } from '../../../../shared/worktree/id'
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
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'

/** The longest a workspace's first surface waits for main's placement pass. */
export const FIRST_SURFACE_PLACEMENT_WAIT_MS = 500

export abstract class OrcaRuntimeWithRestoredTerminalPlacement extends OrcaRuntimeWithAutomationOperations {
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>
  /** Shows a restored pane whose terminal is gone as sleeping, unless it already has a status. */
  protected abstract notePaneSleeping(paneKey: string): void

  private placementRun: Promise<LiveTerminalPlacement> | null = null
  /** What the next pass covers: every workspace, or the ones a window's sweep asked for. */
  private placementQueued: 'all' | Set<string> | null = null
  /** The one pass running now, without the passes queued behind it, and what it covers. */
  private placementPass: {
    run: Promise<LiveTerminalPlacement>
    scope: 'all' | ReadonlySet<string>
  } | null = null
  private stopFollowingProviderRebinds: (() => void) | null = null

  /**
   * Layout-owner build: shows every live local terminal no pane shows, or only `worktreeId`'s.
   * Runs at startup, window load and client attach, after the terminal service is replaced, and
   * for one workspace on each window sweep. One pass at a time: a call during a pass runs one
   * more pass after it, so a terminal seen late is still placed.
   */
  placeUnshownLiveTerminals(worktreeId?: string): Promise<LiveTerminalPlacement> {
    this.stopFollowingProviderRebinds ??= onLocalPtyProviderRebound(
      () => void placeUnshownLiveTerminalsBestEffort(this)
    )
    const queued = this.placementQueued
    this.placementQueued =
      worktreeId === undefined || queued === 'all'
        ? 'all'
        : new Set([...(queued ?? []), worktreeId])
    if (this.placementRun) {
      return this.placementRun
    }
    const run = async (): Promise<LiveTerminalPlacement> => {
      let placement: LiveTerminalPlacement
      do {
        const scope = this.placementQueued ?? 'all'
        this.placementQueued = null
        this.placementPass = { run: this.placeUnshownLiveTerminalsOnce(scope), scope }
        placement = await this.placementPass.run
      } while (this.placementQueued)
      return placement
    }
    this.placementRun = run().finally(() => {
      this.placementRun = null
      this.placementPass = null
    })
    return this.placementRun
  }

  /**
   * Layout-owner build: a window's sweep (first visit, an empty or sleeping activation, a phone
   * wake) shows that workspace's unshown live terminals before it reads which ones are shown.
   */
  async placeUnshownLiveTerminalsOf(worktreeSelector: string): Promise<void> {
    const worktreeId = getExplicitWorktreeIdSelector(worktreeSelector)
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || !worktreeId) {
      return
    }
    try {
      await this.placeUnshownLiveTerminals(worktreeId)
    } catch (error) {
      console.warn('[layout] showing live terminals failed:', error)
    }
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
    // A sweep's pass places only its own workspace's terminals: another workspace waits for none.
    const { scope } = pass
    if (
      scope !== 'all' &&
      ![...scope].some((worktreeId) => worktreeIdsEqual(worktreeId, command.workspace))
    ) {
      return null
    }
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_SURFACE_PLACEMENT_WAIT_MS)
    })
    return Promise.race([pass.run.catch(() => {}), cap]).finally(() => clearTimeout(timer))
  }

  private async placeUnshownLiveTerminalsOnce(
    scope: 'all' | ReadonlySet<string>
  ): Promise<LiveTerminalPlacement> {
    // A sweep's pass leaves other workspaces, and their panes, as they are.
    if (scope === 'all') {
      await this.unbindPanesFromOtherWorkspacesTerminals()
    }
    // A host that keeps no local terminals across restarts has none to find.
    if (!this.canRecoverPersistentLocalPtysFn()) {
      if (scope === 'all') {
        this.markDeadBoundPanesSleeping()
      }
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
      ptys: () =>
        scope === 'all'
          ? this.ptysById.values()
          : [...this.ptysById.values()].filter((pty) =>
              [...scope].some((worktreeId) => worktreeIdsEqual(worktreeId, pty.worktreeId))
            ),
      // A window spawn holds its workspace's lock until its pane is recorded (spawn-run.ts), and a
      // registration in flight is binding one, as a census reads it (pty-terminal-summary.ts).
      isStillBinding: (pty) =>
        this.pendingPtyRegistrationIncarnations.has(pty.ptyId) ||
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
    if (censusRead && scope === 'all') {
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
