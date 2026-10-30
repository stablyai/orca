import type { WorktreeSetupLaunch } from '../../../../shared/worktree/launch-types'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import {
  reconcilePreparedTerminalPublications,
  publishPreparedTerminal
} from './prepared-terminal-publication'
import type { PreparedTerminalPrompts } from '../../../daemon/prepared-agent-launch-protocol'
import type { PreparedAgentLaunchIdentity } from '../../../../shared/prepared-agent-launch'
import { isPreparedAgentLaunchDescriptor } from '../../../../shared/prepared-agent-launch'
import { PreparedTerminalPendingError } from './prepared-terminal-pending'
import {
  startPreparedWorktreeTerminals,
  type PreparedTerminalStart
} from './prepared-worktree-terminal-start'
import { OrcaRuntimeWithTerminalCreateDeduplication } from './terminal-create-deduplication'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { mintPtySessionId } from '../../../daemon/pty-session-id'
import { prepareWorkspaceTerminalSpawn } from './prepare-workspace-terminal-spawn'
import { terminalCreateTeamAllocation } from './terminal-create-team-allocation'
import { agentLaunchTokenFor } from '../../../agent-launch/agent-launch-token'
import { admitRuntimePane } from '../../runtime-pane-admission'
import type { PreparedAgentLaunchDescriptor } from '../../../../shared/prepared-agent-launch'
import { paneSize, resolvePtyFirstSize } from '../../../ipc/pty/pty-first-size'

export abstract class OrcaRuntimeWithPreparedTerminals extends OrcaRuntimeWithTerminalCreateDeduplication {
  protected abstract paneStartStatusArgs: dependencies.PaneStartArgsOf

  async startSetupAgentTerminals(
    selector: string,
    setup: WorktreeSetupLaunch | undefined,
    startupOptions: dependencies.TerminalCreateOptions,
    onAgentPublished: (terminal: dependencies.RuntimeTerminalCreate) => void,
    created?: dependencies.Worktree,
    prompts?: PreparedTerminalPrompts,
    color?: string
  ) {
    const controller = this.ptyController
    if (
      !controller?.prepareSpawn ||
      !controller.preparedAgentLaunch ||
      !(await controller.supportsPreparedAgentLaunches?.())
    ) {
      return null
    }
    const workspace = await this.resolveTerminalCreateLaunchScope(selector, created, startupOptions)
    if (workspace.connectionId) {
      return null
    }
    const store = await this.openAgentSessionRecordStore()
    return startPreparedWorktreeTerminals({
      worktreeId: workspace.id,
      setup,
      startupOptions,
      prompts,
      color,
      targetKind: created ? (workspace.folderWorkspace ? 'new-folder' : 'new-git') : 'existing',
      ports: {
        controller,
        store,
        setTabColor: (handle, color) =>
          this.getWorktreeTerminalProvisioningHost().setTabColor(handle, color),
        placePrimary: this.placePreparedPrimary.bind(this),
        deliverPrompts: this.deliverPreparedTerminalPrompts.bind(this),
        prepare: (options) => this.prepareTerminalForSetup(selector, options, created),
        createClaim: (operationId, spawn) => {
          const agent = startupOptions.launchAgent
          if (!agent) {
            throw new Error('agent_session_identity_required')
          }
          return this.agentSessionClaimSigner.createFreshLaunchClaim({
            operationId,
            canonicalWorktreeId: workspace.id,
            agent,
            hostScope: JSON.stringify({
              hostId: 'local',
              distro: spawn.terminalWindowsWslDistro ?? null
            })
          })
        },
        createTerminal: (target, options) => this.createTerminal(target, options, created),
        onAgentPublished
      }
    })
  }

  protected async reconcilePreparedTerminalLaunches(
    controller: RuntimePtyController
  ): Promise<void> {
    if (!(await controller.supportsPreparedAgentLaunches?.())) {
      return
    }
    await reconcilePreparedTerminalPublications({
      controller,
      store: await this.openAgentSessionRecordStore(),
      createTerminal: (selector, options) => this.createTerminal(selector, options),
      setTabColor: (handle, color) =>
        this.getWorktreeTerminalProvisioningHost().setTabColor(handle, color),
      placePrimary: this.placePreparedPrimary.bind(this),
      deliverPrompts: this.deliverPreparedTerminalPrompts.bind(this)
    })
  }

  async waitForPreparedAgentTerminal(
    identity: PreparedAgentLaunchIdentity
  ): Promise<dependencies.RuntimeTerminalCreate> {
    const controller = this.ptyController
    const store = await this.openAgentSessionRecordStore()
    const row = store
      .listOperationRows()
      .find(
        (row) =>
          row.operationId === identity.operationId && row.fingerprint === identity.fingerprint
      )
    if (!controller || !isPreparedAgentLaunchDescriptor(row?.preparedLaunch)) {
      throw new PreparedTerminalPendingError(identity)
    }
    try {
      const terminal = await publishPreparedTerminal(identity, row.preparedLaunch, {
        controller,
        store,
        createTerminal: (selector, options) => this.createTerminal(selector, options),
        setTabColor: (handle, color) =>
          this.getWorktreeTerminalProvisioningHost().setTabColor(handle, color),
        placePrimary: this.placePreparedPrimary.bind(this),
        deliverPrompts: this.deliverPreparedTerminalPrompts.bind(this)
      })
      if (!terminal) {
        throw new Error('The agent was not started because Setup did not complete successfully.')
      }
      return terminal
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'The agent was not started because Setup did not complete successfully.'
      ) {
        throw error
      }
      throw new PreparedTerminalPendingError(identity)
    }
  }

  private async placePreparedPrimary(descriptor: PreparedAgentLaunchDescriptor): Promise<void> {
    const { surface, presentation } = descriptor
    const outcome = await admitRuntimePane(
      this.store,
      {
        type: 'createTerminalTab',
        workspace: surface.worktreeId,
        tabId: surface.tabId,
        leafId: surface.leafId,
        ...(presentation.groupId ? { groupId: presentation.groupId } : {}),
        ...(presentation.title ? { title: presentation.title } : {}),
        ...(presentation.splitPlacement?.afterTabId
          ? { afterTabId: presentation.splitPlacement.afterTabId }
          : { index: 0 })
      },
      undefined
    )
    if (outcome !== undefined && outcome !== 'admitted' && outcome !== 'exists') {
      throw new Error(outcome === 'tab_closed' ? 'tab_not_found' : 'terminal_pane_unavailable')
    }
  }

  private async deliverPreparedTerminalPrompts(
    terminal: dependencies.RuntimeTerminalCreate,
    prompts: PreparedTerminalPrompts
  ): Promise<boolean> {
    if (prompts.draft && !(await this.pasteStartupDraftWhenReady(terminal.handle, prompts.draft))) {
      return false
    }
    return !prompts.followup || this.deliverStartupFollowup(terminal.handle, prompts.followup)
  }

  private async prepareTerminalForSetup(
    selector: string,
    options: dependencies.TerminalCreateOptions,
    created?: dependencies.Worktree
  ): Promise<PreparedTerminalStart> {
    const controller = this.ptyController
    if (!controller?.prepareSpawn) {
      throw new Error('prepared_agent_launch_unsupported')
    }
    const workspace = await this.resolveTerminalCreateLaunchScope(selector, created, options)
    const launchOpts = await this.resolveAgentTerminalCreateOptions(workspace, options)
    const { tabId, leafId } = dependencies.allocateTerminalPaneIdentity(launchOpts)
    const preAllocatedHandle =
      launchOpts.preAllocatedHandle ?? this.createPreAllocatedTerminalHandle()
    const launchToken = agentLaunchTokenFor(launchOpts, dependencies.randomUUID)
    const session = this.getWorkspaceSessionForWorktree(workspace.id)
    const groupId =
      launchOpts.targetGroupId ??
      this.mobileSessionTabsByWorktree.get(workspace.id)?.activeGroupId ??
      session?.activeGroupIdByWorktree?.[workspace.id]
    const singleGroup =
      (session?.tabGroups?.[workspace.id]?.length ?? 0) <= 1
        ? this.singleGroupWorkspaceGridSize
        : undefined
    const group = groupId ? this.terminalGroupGridSizes?.[groupId] : undefined
    const initialSize = resolvePtyFirstSize({
      pane: paneSize(session, options),
      group,
      singleGroup
    })
    const teamAllocation = terminalCreateTeamAllocation(this.claudeAgentTeams)
    try {
      const prepared = await prepareWorkspaceTerminalSpawn({
        workspace,
        launchOpts,
        initialSize,
        cwd: this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path,
        preAllocatedHandle,
        tabId,
        leafId,
        launchToken,
        teamAllocation,
        releaseStablePaneCreate() {},
        reportPtySpawnCommitted() {},
        launcherSpawnArgs: dependencies.admitPairedCreateColors(
          options.terminalColorQueryReplies,
          options.terminalViewAttributes
        ),
        ports: {
          claudeAgentTeamsMode: this.store?.getSettings?.().claudeAgentTeamsMode,
          buildTerminalWorkspaceEnv: this.buildTerminalWorkspaceEnv.bind(this),
          paneStartStatusArgs: this.paneStartStatusArgs
        }
      })
      const spawn = await controller.prepareSpawn({
        ...prepared.spawnArgs,
        sessionId: mintPtySessionId(workspace.id),
        isNewSession: true
      })
      return {
        spawn,
        surface: { worktreeId: workspace.id, tabId, leafId, terminalHandle: preAllocatedHandle },
        options: {
          ...launchOpts,
          launchConfig: prepared.effectiveLaunchConfig,
          ...(launchToken ? { launchToken } : {}),
          tabId,
          leafId,
          preAllocatedHandle,
          ...(groupId ? { targetGroupId: groupId } : {})
        },
        commit: () => teamAllocation.acceptFresh({}),
        release: teamAllocation.release
      }
    } catch (error) {
      teamAllocation.release()
      throw error
    }
  }
}
