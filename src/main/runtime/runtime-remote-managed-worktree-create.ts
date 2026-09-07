import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { getSetupRunnerCommandPlatformForPath } from '../../shared/setup-runner-command'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { WorktreeTerminalProvisioningArgs } from './runtime-worktree-terminal-provisioning'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import {
  requestRuntimeRemoteWorktree,
  type RuntimeRemoteWorktreeCreateArgs
} from './runtime-remote-worktree-create-request'
import { finishRuntimeRemoteWorktreeCreate } from './runtime-remote-worktree-create-result'

type Dependencies = {
  store: RuntimeStore
  canSpawn(): boolean
  markTrusted(
    agent: NonNullable<RuntimeRemoteWorktreeCreateArgs['createdWithAgent']>,
    connectionId: string,
    path: string
  ): Promise<void>
  createTerminal(
    selector: string,
    options: TerminalCreateOptions
  ): Promise<{
    handle: string
    tabId?: string | null
    paneKey?: string | null
    ptyId?: string | null
  }>
  pasteDraft(handle: string, draft: WorktreeStartupDraftPaste): void
  sendFollowup(handle: string, followup: WorktreeStartupFollowup): void
  provision(
    args: WorktreeTerminalProvisioningArgs
  ): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }>
  activate(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: RuntimeRemoteWorktreeCreateArgs['startup'],
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void
  invalidateResolvedWorktrees(): void
  invalidateWorktreeScan(repoId: string): void
  notifyWorktreesChanged(repoId: string): void
}

function setupPlatform(setup: CreateWorktreeResult['setup']): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', 'posix')
}

function ownerSurfacing(surface: boolean): { surfaceOwner?: false } {
  return surface ? {} : { surfaceOwner: false }
}

export async function createRuntimeRemoteManagedWorktree(
  repo: Repo,
  args: RuntimeRemoteWorktreeCreateArgs,
  deps: Dependencies
): Promise<CreateWorktreeResult> {
  if (!deps.store) {
    throw new Error('runtime_unavailable')
  }

  const result = await requestRuntimeRemoteWorktree(repo, args, deps.store)

  deps.invalidateResolvedWorktrees()
  deps.invalidateWorktreeScan(repo.id)
  deps.notifyWorktreesChanged(repo.id)

  const shouldActivate = args.activate === true || args.runHooks === true
  let warning = result.warning
  let didSpawnStartup = false
  // Why: same no-double-spawn contract as the local path — once runtime
  // provisions setup, omit it from activation and the RPC result.
  let didSpawnSetup = false
  let setupTerminalHandle: string | null = null
  let startupTerminalHandle: string | null = null
  let startupTerminalTabId: string | null = null
  let startupTerminalPaneKey: string | null = null
  let startupTerminalPtyId: string | null = null

  let sequencedStartup = args.startup
  let wrappedSetupCommandStr: string | undefined
  if (args.startup && result.setup?.waitForAgentStartup === true) {
    const platform = setupPlatform(result.setup)
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: result.setup.runnerScriptPath,
      startupCommand: args.startup.command,
      platform,
      shell: result.setup.shell
    })
    sequencedStartup = {
      ...args.startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...args.startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommandStr = sequenced.setupCommand
  }

  if (sequencedStartup && deps.canSpawn()) {
    try {
      const startupTrustAgent = args.startupDraftPaste?.agent ?? args.createdWithAgent
      if (startupTrustAgent) {
        await deps.markTrusted(startupTrustAgent, repo.connectionId!, result.worktree.path)
      }
      const terminal = await deps.createTerminal(`path:${result.worktree.path}`, {
        command: sequencedStartup.command,
        ...(result.setup && args.startup
          ? { claudeAgentTeamsSourceCommand: args.startup.command }
          : {}),
        env: sequencedStartup.env,
        ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
        ...(args.createdWithAgent ? { launchAgent: args.createdWithAgent } : {}),
        ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
        startupCommandDelivery: sequencedStartup.startupCommandDelivery,
        telemetry: sequencedStartup.telemetry,
        ...ownerSurfacing(shouldActivate)
      })
      if (args.startupDraftPaste) {
        deps.pasteDraft(terminal.handle, args.startupDraftPaste)
      }
      if (args.startupFollowup) {
        deps.sendFollowup(terminal.handle, args.startupFollowup)
      }
      didSpawnStartup = true
      startupTerminalHandle = terminal.handle
      startupTerminalTabId = terminal.tabId ?? null
      startupTerminalPaneKey = terminal.paneKey ?? null
      startupTerminalPtyId = terminal.ptyId ?? null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warning = warning
        ? `${warning} Also failed to create the startup terminal for ${result.worktree.path}: ${message}`
        : `Failed to create the startup terminal for ${result.worktree.path}: ${message}`
    }
  }

  if (shouldActivate) {
    const runtimeWillProvisionTerminals =
      didSpawnStartup && Boolean(result.setup || result.defaultTabs)
    if (runtimeWillProvisionTerminals) {
      // Why: remote/mobile task creates spawn the agent terminal in runtime,
      // so renderer activation may not materialize setup/default tabs. Await so
      // a failed setup spawn falls back to renderer activation for retry.
      const provisioned = await deps.provision({
        worktreeSelector: `path:${result.worktree.path}`,
        worktreeId: result.worktree.id,
        worktreePath: result.worktree.path,
        ...(result.setup ? { setup: result.setup } : {}),
        ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
        primaryTerminalHandle: startupTerminalHandle,
        hasStartupTerminal: didSpawnStartup,
        setupCommandPlatform: setupPlatform(result.setup),
        observeSetupCompletion: args.observeSetupCompletion,
        // Why: carry the wait-for-agent wrapped setup command (#6298) so the
        // remote Setup tab runs the same script the sequenced agent waits on.
        ...(wrappedSetupCommandStr ? { wrappedSetupCommand: wrappedSetupCommandStr } : {})
      })
      didSpawnSetup = provisioned.setupSpawned
      setupTerminalHandle = provisioned.setupTerminalHandle
    }
    // Why: omit setup from activation when runtime spawned it; on spawn
    // failure fall through with the wrapped command so renderer retries.
    const activationSetup = didSpawnSetup
      ? undefined
      : result.setup
        ? {
            ...result.setup,
            ...(didSpawnStartup && wrappedSetupCommandStr
              ? { command: wrappedSetupCommandStr }
              : {})
          }
        : undefined
    const activationDefaultTabs = runtimeWillProvisionTerminals ? undefined : result.defaultTabs
    if (args.startup && !didSpawnStartup) {
      deps.activate(
        repo.id,
        result.worktree.id,
        activationSetup,
        args.startup,
        activationDefaultTabs
      )
    } else {
      deps.activate(repo.id, result.worktree.id, activationSetup, undefined, activationDefaultTabs)
    }
  }

  if (
    !shouldActivate &&
    deps.canSpawn() &&
    (result.setup || result.defaultTabs || didSpawnStartup)
  ) {
    // Why: inactive terminal materialization matches normal worktree creation,
    // but setup/default tab failures must not gate automation dispatch.
    const provisioning = deps.provision({
      worktreeSelector: `path:${result.worktree.path}`,
      worktreeId: result.worktree.id,
      worktreePath: result.worktree.path,
      ...(result.setup ? { setup: result.setup } : {}),
      ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
      primaryTerminalHandle: startupTerminalHandle,
      hasStartupTerminal: didSpawnStartup,
      setupCommandPlatform: setupPlatform(result.setup),
      observeSetupCompletion: args.observeSetupCompletion,
      ...(wrappedSetupCommandStr ? { wrappedSetupCommand: wrappedSetupCommandStr } : {}),
      surfaceOwner: false
    })
    // Why: runtime owns setup spawning here, so omit setup from the RPC result
    // to keep the headless/mobile caller from launching it a second time.
    if (args.awaitTerminalProvisioning) {
      const provisioned = await provisioning
      didSpawnSetup = provisioned.setupSpawned
      setupTerminalHandle = provisioned.setupTerminalHandle
    } else {
      void provisioning
      if (result.setup) {
        didSpawnSetup = true
      }
    }
  } else if (!shouldActivate && deps.canSpawn()) {
    try {
      await deps.createTerminal(`path:${result.worktree.path}`, { surfaceOwner: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warning = warning
        ? `${warning} Also failed to create the initial terminal for ${result.worktree.path}: ${message}`
        : `Failed to create the initial terminal for ${result.worktree.path}: ${message}`
    }
  }

  return finishRuntimeRemoteWorktreeCreate({
    result,
    request: args,
    ...(warning ? { warning } : {}),
    didSpawnSetup,
    didSpawnStartup,
    ...(wrappedSetupCommandStr ? { wrappedSetupCommand: wrappedSetupCommandStr } : {}),
    setupTerminalHandle,
    startupTerminalHandle,
    startupTerminalTabId,
    startupTerminalPaneKey,
    startupTerminalPtyId
  })
}
