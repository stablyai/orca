// Main restores unshown live terminals and reconnect facts at startup/window load, including headless hosts.

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

export const FIRST_SURFACE_PLACEMENT_WAIT_MS = 500

export abstract class OrcaRuntimeWithRestoredTerminalPlacement extends OrcaRuntimeWithAutomationOperations {
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>
  protected abstract notePaneSleeping(paneKey: string): void

  private placementRun: Promise<LiveTerminalPlacement> | null = null
  private placementQueued: 'all' | Set<string> | null = null
  private placementPass: {
    run: Promise<LiveTerminalPlacement>
    scope: 'all' | ReadonlySet<string>
  } | null = null
  private stopFollowingProviderRebinds: (() => void) | null = null

  /** Serialize startup, window, attach and provider-rebind placement; a call during a pass queues another so late terminals are included. Optional workspace scope supports sweeps. */
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

  /** Place this workspace's unshown terminals before the window sweep reads its listing. */
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

  /** First-surface creation waits for the current applicable pass, excluding queued passes. Cap at FIRST_SURFACE_PLACEMENT_WAIT_MS; slower placement may leave an extra tab. */
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
      paneOf: (pty) => this.paneOfPty(pty),
      // Window spawns hold the workspace lock through pane recording; pending registration also reserves its binding.
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
          // This claim has no graph standing; a later window graph wins.
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
