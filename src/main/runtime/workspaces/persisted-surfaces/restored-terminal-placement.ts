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
import type { WindowLayoutCommand } from '../../runtime-layout-apply'
import {
  placeUnshownLiveTerminals,
  type LiveTerminalPlacement
} from '../../terminal/adoption/unshown-live-terminal-placement'
import {
  deriveShutdownReconnectFacts,
  type ShutdownReconnectFacts
} from '../../terminal/recovery/shutdown-reconnect-facts'
import { OrcaRuntimeWithAutomationOperations } from './automation-operations'

export abstract class OrcaRuntimeWithRestoredTerminalPlacement extends OrcaRuntimeWithAutomationOperations {
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>

  /** Layout-owner build: shows every live local terminal no pane shows (startup, window load). */
  async placeUnshownLiveTerminals(): Promise<LiveTerminalPlacement> {
    // A host that keeps no local terminals across restarts has none to find.
    if (!this.canRecoverPersistentLocalPtysFn()) {
      return { placed: [], declined: [] }
    }
    return placeUnshownLiveTerminals({
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
