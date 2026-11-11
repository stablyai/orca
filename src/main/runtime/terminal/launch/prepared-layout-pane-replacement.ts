import type { RetainedTerminalAttempt } from './retained-terminal-attempt'
import { isUnknownSpawnFailure } from '../../../ipc/pty/spawn-failure-settlement'
import { OrcaRuntimeWithCreateTerminal } from './terminal-create'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../layout/runtime-layout-apply'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  makePaneSpawnReservationKey,
  reserveIdlePaneSpawn,
  rejectPaneSpawnReservation,
  type PaneSpawnReservation
} from '../../../ipc/pty/pane/spawn-reservation'
import {
  parseExecutionHostId,
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { PreparedPaneReplacement } from '../recovery/prepared-pane-replacement'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { deriveHeadlessLegacyTerminalLeafId } from '../surface/mobile-session-layout-projection'
import type { RestoredPane } from '../recovery/restored-pane-start'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { buildHeadlessMobileSessionTerminalTabs } from '../surface/mobile-session-terminal-projection'
import { resolvePtySpawnStartupTarget } from '../../../ipc/pty/spawn-startup-target'
import { resolveTerminalStartupCwd } from '../../../../shared/shell/launch/terminal-startup-cwd'
import { runAsWslLaunchUserAct } from '../../../wsl/discovery/wsl-background-exec-gate'
import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

/** Prepares one replacement before layout can retire its old process. */
export abstract class OrcaRuntimeWithPreparedLayoutPaneReplacement extends OrcaRuntimeWithCreateTerminal {
  protected abstract layoutCommandRun(
    command: WindowLayoutCommand
  ): LayoutCommandRunOptions | undefined

  protected async prepareLayoutCommandRun(
    command: WindowLayoutCommand,
    caller: Pick<LayoutCommandRunOptions, 'admit' | 'visibility'> = {}
  ): Promise<{ run: LayoutCommandRunOptions; release: () => void }> {
    const base = this.layoutCommandRun(command)
    const ordinary = { run: { ...base, ...caller }, release: () => {} }
    if (!base || (command.type !== 'restartPane' && command.type !== 'startPane')) {
      return ordinary
    }
    const pane = parsePaneKey(command.paneKey)
    if (!pane) {
      return ordinary
    }
    const store = this.store
    const hostId = this.getWorkspaceSessionHostIdsForTab(command.workspace, pane.tabId)[0]
    if (
      !store?.getWorkspaceSession ||
      !hostId ||
      parseExecutionHostId(hostId)?.kind === 'runtime'
    ) {
      return ordinary
    }
    const binding = () => {
      const session = store.getWorkspaceSession!(hostId)
      const tab = session.tabsByWorktree?.[command.workspace]?.find((row) => row.id === pane.tabId)
      const layout = session.terminalLayoutsByTabId?.[pane.tabId]
      const leaves = layout?.root
        ? collectLeafIds(layout.root)
        : tab
          ? [deriveHeadlessLegacyTerminalLeafId(tab.id)]
          : []
      if (!tab || !leaves.some((leaf) => leaf === pane.leafId)) {
        return null
      }
      const ptyId =
        layout?.ptyIdsByLeafId?.[pane.leafId] ??
        (leaves.length === 1 ? tab.ptyId : undefined) ??
        undefined
      return {
        session,
        ptyId,
        incarnationId: session.terminalPtyIncarnationsByPaneKey?.[command.paneKey],
        runtimeIncarnationId: ptyId ? this.ptysById.get(ptyId)?.incarnationId : undefined,
        generation: store.getPtyBindingGeneration?.(hostId, pane.leafId) ?? 0
      }
    }
    const isReplacement = (owner: ReturnType<typeof binding>) =>
      owner &&
      (command.type === 'restartPane' ||
        Boolean(owner.ptyId && base.live?.retiresBinding?.(command.paneKey, owner.ptyId)))
    if (!isReplacement(binding())) {
      return ordinary
    }
    const parsedHost = parseExecutionHostId(hostId)
    const key = makePaneSpawnReservationKey(
      command.workspace,
      parsedHost?.kind === 'ssh' ? parsedHost.targetId : null,
      command.paneKey
    )!
    const reservation = await reserveIdlePaneSpawn(key)
    let prepared: PreparedPaneReplacement | undefined
    let retainedAttempt: RetainedTerminalAttempt | null = null
    try {
      const owner = binding()
      if (!isReplacement(owner) || !owner) {
        rejectPaneSpawnReservation(key, reservation, new Error('terminal_replacement_not_started'))
        return ordinary
      }
      retainedAttempt = this.beginRetainedTerminalAttempt(
        command.workspace,
        pane.tabId,
        pane.leafId,
        { key, reservation }
      )
      prepared = await this.prepareRestoredPaneReplacement(
        { worktreeId: command.workspace, ...pane },
        key,
        reservation,
        owner.session,
        hostId,
        owner.ptyId
      )
      prepared.retainedAttempt = retainedAttempt ?? undefined
      const current = (): boolean => {
        const now = binding()
        return (
          this.getWorkspaceSessionHostIdsForTab(command.workspace, pane.tabId)[0] === hostId &&
          now !== null &&
          now.ptyId === owner.ptyId &&
          now.incarnationId === owner.incarnationId &&
          now.runtimeIncarnationId === owner.runtimeIncarnationId &&
          now.generation === owner.generation
        )
      }
      const operation = prepared
      return {
        release: () => operation.releaseIfUnclaimed(),
        run: {
          ...base,
          ...caller,
          admit: (partitions) => current() && (caller.admit?.(partitions) ?? true),
          stopBeforeWrite: (ids) =>
            current() &&
            ids.every((id) => id === owner.ptyId) &&
            (base.stopBeforeWrite?.(ids) ?? true),
          onEffects: (effects) => {
            if (!effects.startPaneKeys.includes(command.paneKey)) {
              return
            }
            operation.handoffToStart()
            try {
              void this.ensureRestoredPaneStarted(
                { worktreeId: command.workspace, ...pane },
                { preparedReplacement: operation }
              )
                .catch(() => {})
                .finally(() => operation.releaseUnused())
            } catch (error) {
              operation.releaseUnused()
              throw error
            }
          }
        }
      }
    } catch (error) {
      let failure = error
      try {
        if (!isUnknownSpawnFailure(error)) {
          failure = retainedAttempt?.failed(error) ?? error
        }
      } finally {
        retainedAttempt?.finalized()
      }
      if (prepared) {
        prepared.releaseUnused()
      } else {
        rejectPaneSpawnReservation(key, reservation, failure)
      }
      throw failure
    }
  }

  protected async prepareRestoredPaneReplacement(
    pane: RestoredPane,
    reservationKey: string,
    reservation: PaneSpawnReservation,
    session: WorkspaceSessionState,
    hostId: ExecutionHostId,
    stoppedPtyId: string | undefined
  ): Promise<PreparedPaneReplacement> {
    const tab =
      session &&
      buildHeadlessMobileSessionTerminalTabs(
        pane.worktreeId,
        session.tabsByWorktree?.[pane.worktreeId] ?? [],
        session
      ).find((row) => row.parentTabId === pane.tabId && row.leafId === pane.leafId)
    if (!tab) {
      throw new Error('tab_not_found')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${pane.worktreeId}`)
    if (
      workspace.id !== pane.worktreeId ||
      getConnectionExecutionHostId(workspace.connectionId) !== hostId
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    const startup = await this.prepareRestoredPaneStartup(pane.worktreeId, tab)
    try {
      const cwd =
        this.resolveWorkspaceTerminalStartupCwd(workspace, tab.startupCwd) ?? workspace.path
      const target = await resolvePtySpawnStartupTarget({
        worktreeId: workspace.id,
        cwd,
        sessionId: undefined,
        shellOverride: undefined,
        plannedPty: startup.agentStartup.launchRuntime?.pty,
        projectRuntimeSource: {
          kind: 'store',
          store: this.store ?? undefined,
          workspace,
          connectionId: workspace.connectionId,
          tabId: pane.tabId
        },
        preAdopted: false,
        getSettings: this.store?.getSettings?.bind(this.store),
        resolveStartupCwd: (_id, requested, fallback) =>
          resolveTerminalStartupCwd(workspace.path, requested, fallback),
        wslStartHold: { wslBackgroundStart: true }
      })
      const release = await runAsWslLaunchUserAct(
        {
          isWsl: Boolean(target.expectedWslDistro),
          distro: target.expectedWslDistro,
          passiveRestore: true
        },
        () =>
          this.acquireWorktreeTerminalSpawn(
            spawnWorktreeTarget(workspace.id, workspace.connectionId)
          )
      )
      return new PreparedPaneReplacement(
        workspace,
        pane.tabId,
        pane.leafId,
        stoppedPtyId,
        reservationKey,
        reservation,
        target,
        startup,
        release
      )
    } catch (error) {
      const resume = startup.resumeStartup
      if (resume && 'resumeClaim' in resume) {
        resume.resumeClaim?.settleFailure(false, error)
      }
      throw error
    }
  }
}
