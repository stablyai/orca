import {
  attemptWorktreeTerminalStartup,
  settleWorktreeStartupProvisioning,
  setupPlatform,
  ownerSurfacing,
  type WorktreeStartupProvisioner
} from './runtime-worktree-terminal-startup-attempt'
import { paneIdentity } from './runtime-terminal-pane-identity'
import { navigationTargetsHost } from '../../shared/runtime-navigation'
import {
  backgroundAgentCreateLeavesSurface,
  shouldSeedWorktreePrimaryTerminal
} from '../../shared/worktree-first-surface'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type { WorktreeTerminalProvisioningArgs } from './runtime-worktree-terminal-provisioning'

type Ports = {
  canSpawn: boolean
  provisionInBackground?: () => boolean
  /** A running creation operation builds this workspace's first surface itself. */
  launchOwnsFirstSurface?: (worktreeId: string) => boolean
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  pasteDraft: (handle: string, draft: WorktreeStartupDraftPaste) => void
  sendFollowup: (handle: string, followup: WorktreeStartupFollowup) => void
  provision: WorktreeStartupProvisioner
  activate: (
    repoId: string,
    worktreeId: string,
    startup?: WorktreeStartupLaunch,
    // Only work main tried to start and failed; the host window retries it where the user sees it.
    failedSetup?: CreateWorktreeResult['setup'],
    failedDefaultTabs?: CreateWorktreeResult['defaultTabs'],
    providesInitialSurface?: boolean
  ) => void
}

export type RuntimeLocalWorktreeTerminalStartupResult = {
  warning?: string
  returnedSetup?: CreateWorktreeResult['setup']
  didSpawnSetup: boolean
  didSpawnStartup: boolean
  setupTerminalHandle: string | null
  startupTerminalHandle: string | null
  startupTerminalTabId: string | null
  startupTerminalPaneKey: string | null
  startupTerminalPtyId: string | null
}

export async function startRuntimeLocalWorktreeTerminals(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  worktree: Worktree
  setup?: CreateWorktreeResult['setup']
  defaultTabs?: CreateWorktreeResult['defaultTabs']
  startup?: WorktreeStartupLaunch
  startupFollowup?: WorktreeStartupFollowup
  /** What a host-built startup was quoted for, or the repair error it fails with. */
  startupLaunchRuntime?: AgentLaunchRuntime | Error
  createdWithAgent?: TuiAgent
  draftPaste?: WorktreeStartupDraftPaste
  warning?: string
  ports: Ports
}): Promise<RuntimeLocalWorktreeTerminalStartupResult> {
  const { request, repo, worktree, setup, defaultTabs, startup, ports } = args
  const shouldActivate = request.activate === true || request.runHooks === true
  const launchOwnsSurface = ports.launchOwnsFirstSurface?.(worktree.id) === true
  let warning = args.warning
  let didSpawnStartup = false
  let didSpawnSetup = false
  let setupTerminalHandle: string | null = null
  let startupTerminalHandle: string | null = null
  let startupTerminalTabId: string | null = null
  let startupTerminalPaneKey: string | null = null
  let startupTerminalPtyId: string | null = null
  let sequencedStartup = startup
  let wrappedSetupCommand: string | undefined
  let primaryTerminalHandle: string | null = null
  let startupFailure: Awaited<ReturnType<typeof attemptWorktreeTerminalStartup>>['failure']
  if (startup && setup?.waitForAgentStartup === true) {
    const platform = setupPlatform(setup, process.platform === 'win32' ? 'windows' : 'posix')
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup.command,
      platform,
      shell: setup.shell
    })
    sequencedStartup = {
      ...startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommand = sequenced.setupCommand
  }

  if (sequencedStartup) {
    const attempted = await attemptWorktreeTerminalStartup({
      selector: `id:${worktree.id}`,
      options: {
        command: sequencedStartup.command,
        ...(request.startupCwd ? { cwd: request.startupCwd } : {}),
        ...paneIdentity(request.startupPaneKey),
        ...(setup && startup ? { claudeAgentTeamsSourceCommand: startup.command } : {}),
        env: sequencedStartup.env,
        ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
        ...(args.createdWithAgent ? { launchAgent: args.createdWithAgent } : {}),
        ...(args.startupLaunchRuntime && !(args.startupLaunchRuntime instanceof Error)
          ? { launchRuntime: args.startupLaunchRuntime }
          : {}),
        ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
        startupCommandDelivery: sequencedStartup.startupCommandDelivery,
        telemetry: sequencedStartup.telemetry,
        ...ownerSurfacing(shouldActivate && navigationTargetsHost(request.navigation ?? 'host'))
      },
      ...(args.startupLaunchRuntime instanceof Error
        ? { runtimeError: args.startupLaunchRuntime }
        : {}),
      canSpawn: ports.canSpawn,
      owned: launchOwnsSurface,
      recoveryOptions: ownerSurfacing(
        shouldActivate && navigationTargetsHost(request.navigation ?? 'host')
      ),
      create: ports.createTerminal
    })
    primaryTerminalHandle = attempted.primaryTerminal?.handle ?? null
    startupFailure = attempted.failure
    const terminal = attempted.agentTerminal
    if (terminal) {
      if (args.draftPaste) {
        ports.pasteDraft(terminal.handle, args.draftPaste)
      }
      if (args.startupFollowup) {
        ports.sendFollowup(terminal.handle, args.startupFollowup)
      }
      didSpawnStartup = true
      startupTerminalHandle = terminal.handle
      startupTerminalTabId = terminal.tabId ?? null
      startupTerminalPaneKey = terminal.paneKey ?? null
      startupTerminalPtyId = terminal.ptyId ?? null
    } else if (startupFailure) {
      warning = appendFailure(warning, worktree.path, 'startup', startupFailure)
      wrappedSetupCommand = undefined
    }
  }
  const provision: Ports['provision'] = (options) =>
    settleWorktreeStartupProvisioning(
      () => ports.provision(options),
      launchOwnsSurface,
      startupFailure
    )
  const provisionPlan = provisionArgs(
    args,
    primaryTerminalHandle,
    didSpawnStartup,
    wrappedSetupCommand,
    launchOwnsSurface
  )
  if (launchOwnsSurface && startupFailure && !primaryTerminalHandle) {
    provisionPlan.primaryUnavailable = true
  }

  if (shouldActivate) {
    const provisionInBackground = ports.provisionInBackground?.() === true
    // Why: a failed agent start hands the whole create to the window, which seeds the agent's tab
    // first and lays setup and default tabs around it; main provisioning first would leave it no tab.
    const agentStartFailed = Boolean(
      sequencedStartup && ports.canSpawn && !didSpawnStartup && !launchOwnsSurface
    )
    if (agentStartFailed && !provisionInBackground) {
      ports.activate(repo.id, worktree.id, startup, setup, defaultTabs)
    } else {
      let failedSetup: CreateWorktreeResult['setup']
      const runtimeWillProvision =
        ports.canSpawn &&
        (request.awaitTerminalProvisioning === true ||
          provisionInBackground ||
          Boolean(setup || defaultTabs))
      if (runtimeWillProvision) {
        const provisioned = await provision({
          ...provisionPlan,
          ...(provisionInBackground ? { surfaceOwner: false as const } : {})
        })
        didSpawnSetup = provisioned.setupSpawned
        setupTerminalHandle = provisioned.setupTerminalHandle
        if (setup && !didSpawnSetup && (!startupFailure || provisioned.setupRetrySafe)) {
          failedSetup = {
            ...setup,
            ...(didSpawnStartup && wrappedSetupCommand ? { command: wrappedSetupCommand } : {})
          }
        }
      }
      // Creation-owned activation navigates without delegating another primary attempt.
      try {
        ports.activate(
          repo.id,
          worktree.id,
          startup && !didSpawnStartup && !launchOwnsSurface ? startup : undefined,
          failedSetup,
          undefined,
          launchOwnsSurface || undefined
        )
      } catch (error) {
        if (!startupFailure) {
          throw error
        }
        startupFailure.provisioningCauses.push(error)
      }
    }
  } else if (ports.canSpawn && (setup || defaultTabs || didSpawnStartup)) {
    const provisioning = provision({
      ...provisionPlan,
      surfaceOwner: false
    })
    if (request.awaitTerminalProvisioning || (launchOwnsSurface && startupFailure)) {
      const provisioned = await provisioning
      didSpawnSetup = provisioned.setupSpawned
      setupTerminalHandle = provisioned.setupTerminalHandle
    } else {
      void provisioning
      if (setup) {
        didSpawnSetup = true
      }
    }
  } else if (
    ports.canSpawn &&
    shouldSeedWorktreePrimaryTerminal({
      hasPrimarySurface: didSpawnStartup,
      callerProvidesSurface: launchOwnsSurface || backgroundAgentCreateLeavesSurface(args)
    })
  ) {
    try {
      await ports.createTerminal(`id:${worktree.id}`, { surfaceOwner: false })
    } catch (error) {
      warning = appendFailure(warning, worktree.path, 'initial', error)
    }
  }
  if (launchOwnsSurface && startupFailure) {
    throw startupFailure
  }
  const returnedSetup = didSpawnSetup
    ? undefined
    : setup
      ? {
          ...setup,
          ...(didSpawnStartup && wrappedSetupCommand ? { command: wrappedSetupCommand } : {})
        }
      : undefined
  return {
    ...(warning ? { warning } : {}),
    ...(returnedSetup ? { returnedSetup } : {}),
    didSpawnSetup,
    didSpawnStartup,
    setupTerminalHandle,
    startupTerminalHandle,
    startupTerminalTabId,
    startupTerminalPaneKey,
    startupTerminalPtyId
  }
}

function provisionArgs(
  args: Parameters<typeof startRuntimeLocalWorktreeTerminals>[0],
  primaryTerminalHandle: string | null,
  hasStartupTerminal: boolean,
  wrappedSetupCommand?: string,
  launchOwnsSurface = false
): WorktreeTerminalProvisioningArgs {
  return {
    worktreeSelector: `id:${args.worktree.id}`,
    worktreeId: args.worktree.id,
    worktreePath: args.worktree.path,
    ...(args.setup ? { setup: args.setup } : {}),
    ...(args.defaultTabs ? { defaultTabs: args.defaultTabs } : {}),
    primaryTerminalHandle,
    hasStartupTerminal,
    ...(args.request.setupOnly !== undefined ? { setupOnly: args.request.setupOnly } : {}),
    callerProvidesSurface: launchOwnsSurface || backgroundAgentCreateLeavesSurface(args),
    startupNeedsTerminal: args.startup !== undefined && !launchOwnsSurface,
    setupCommandPlatform: setupPlatform(args.setup, 'posix'),
    observeSetupCompletion: args.request.observeSetupCompletion,
    ...(wrappedSetupCommand ? { wrappedSetupCommand } : {})
  }
}

function appendFailure(
  warning: string | undefined,
  path: string,
  kind: 'startup' | 'initial',
  error: unknown
): string {
  const message = error instanceof Error ? error.message : String(error)
  const failure = `failed to create the ${kind} terminal for ${path}: ${message}`
  const combined = warning
    ? `${warning} Also ${failure}`
    : `${failure[0].toUpperCase()}${failure.slice(1)}`
  console.warn(`[worktree-create] ${combined}`)
  return combined
}
