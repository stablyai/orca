import { paneIdentity } from './runtime-terminal-pane-identity'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { shouldSeedWorktreePrimaryTerminal } from '../../shared/worktree-first-surface'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import { getSetupRunnerCommandPlatformForPath } from '../../shared/setup-runner-command'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type {
  WorktreeProvisionTerminalOptions,
  WorktreeTerminalProvisioningArgs
} from './runtime-worktree-terminal-provisioning'

type Ports = {
  canSpawn: boolean
  provisionInBackground?: () => boolean
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  pasteDraft: (handle: string, draft: WorktreeStartupDraftPaste) => void
  sendFollowup: (handle: string, followup: WorktreeStartupFollowup) => void
  provision: (
    options: WorktreeTerminalProvisioningArgs
  ) => Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }>
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
  promisedAgentChat?: boolean
  draftPaste?: WorktreeStartupDraftPaste
  warning?: string
  ports: Ports
}): Promise<RuntimeLocalWorktreeTerminalStartupResult> {
  const { request, repo, worktree, setup, defaultTabs, startup, ports } = args
  const shouldActivate = request.activate === true || request.runHooks === true
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

  // Main owns failed agent startup too, keeping its reason visible without a terminal service.
  if (sequencedStartup && (ports.canSpawn || ORCA_LAYOUT_OWNER_IS_MAIN)) {
    try {
      const launchRuntime = args.startupLaunchRuntime
      if (launchRuntime instanceof Error && !ORCA_LAYOUT_OWNER_IS_MAIN) {
        throw launchRuntime
      }
      const terminal = await ports.createTerminal(`id:${worktree.id}`, {
        command: sequencedStartup.command,
        ...(request.startupCwd ? { cwd: request.startupCwd } : {}),
        ...paneIdentity(request.startupPaneKey),
        ...(setup && startup ? { claudeAgentTeamsSourceCommand: startup.command } : {}),
        env: sequencedStartup.env,
        ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
        ...(args.createdWithAgent ? { launchAgent: args.createdWithAgent } : {}),
        ...(launchRuntime instanceof Error
          ? { startFailure: launchRuntime }
          : launchRuntime
            ? { launchRuntime }
            : {}),
        ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
        startupCommandDelivery: sequencedStartup.startupCommandDelivery,
        telemetry: sequencedStartup.telemetry,
        // Keep failed starts visible in their panes.
        ...(ORCA_LAYOUT_OWNER_IS_MAIN ? { keepPaneOnStartFailure: true as const } : {}),
        ...ownerSurfacing(shouldActivate)
      })
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
    } catch (error) {
      warning = appendFailure(warning, worktree.path, 'startup', error)
    }
  }

  // Failed agents retain their pane; do not seed an extra shell.
  const startupPaneHeld =
    didSpawnStartup || (ORCA_LAYOUT_OWNER_IS_MAIN && Boolean(sequencedStartup))
  if (shouldActivate) {
    const provisionInBackground = ports.provisionInBackground?.() === true
    // Legacy failure hands provisioning to the window, which needs the agent tab first; main provisioning would consume that slot.
    const agentStartFailed = Boolean(sequencedStartup && ports.canSpawn && !didSpawnStartup)
    // Main provisions even without an open window; no window takes over.
    if (!ORCA_LAYOUT_OWNER_IS_MAIN && agentStartFailed && !provisionInBackground) {
      ports.activate(repo.id, worktree.id, startup, setup, defaultTabs)
    } else {
      let failedSetup: CreateWorktreeResult['setup']
      const runtimeWillProvision =
        ports.canSpawn &&
        (request.awaitTerminalProvisioning === true ||
          provisionInBackground ||
          Boolean(setup || defaultTabs))
      if (runtimeWillProvision) {
        const provisioned = await ports.provision({
          ...provisionArgs(args, startupTerminalHandle, startupPaneHeld, wrappedSetupCommand),
          ...(provisionInBackground ? { surfaceOwner: false as const } : {})
        })
        didSpawnSetup = provisioned.setupSpawned
        setupTerminalHandle = provisioned.setupTerminalHandle
        if (setup && !didSpawnSetup) {
          failedSetup = {
            ...setup,
            ...(didSpawnStartup && wrappedSetupCommand ? { command: wrappedSetupCommand } : {})
          }
        }
      }
      ports.activate(
        repo.id,
        worktree.id,
        // Main retains failed startup presentation, not the window.
        ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : startup && !didSpawnStartup ? startup : undefined,
        ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : failedSetup,
        undefined,
        ...(args.promisedAgentChat && !startup ? ([true] as const) : [])
      )
    }
  } else if (ports.canSpawn && (setup || defaultTabs || didSpawnStartup)) {
    const provisioning = ports.provision({
      ...provisionArgs(args, startupTerminalHandle, startupPaneHeld, wrappedSetupCommand),
      surfaceOwner: false
    })
    if (request.awaitTerminalProvisioning) {
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
      hasPrimarySurface: startupPaneHeld,
      callerProvidesSurface: callerProvidesInitialSurface(args)
    })
  ) {
    try {
      await ports.createTerminal(`id:${worktree.id}`, { surfaceOwner: false })
    } catch (error) {
      warning = appendFailure(warning, worktree.path, 'initial', error)
    }
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
  wrappedSetupCommand?: string
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
    callerProvidesSurface: callerProvidesInitialSurface(args),
    startupNeedsTerminal: args.startup !== undefined,
    setupCommandPlatform: setupPlatform(args.setup, 'posix'),
    observeSetupCompletion: args.request.observeSetupCompletion,
    ...(wrappedSetupCommand ? { wrappedSetupCommand } : {})
  }
}

function callerProvidesInitialSurface(
  args: Parameters<typeof startRuntimeLocalWorktreeTerminals>[0]
): boolean {
  // Background agent creates already leave their initial surface to the caller.
  return (
    args.promisedAgentChat === true ||
    (args.createdWithAgent !== undefined &&
      args.request.activate !== true &&
      args.request.runHooks !== true)
  )
}

function setupPlatform(
  setup: CreateWorktreeResult['setup'],
  fallback: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallback)
}

function ownerSurfacing(
  shouldSurface: boolean
): Pick<WorktreeProvisionTerminalOptions, 'surfaceOwner'> {
  return shouldSurface ? {} : { surfaceOwner: false }
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
