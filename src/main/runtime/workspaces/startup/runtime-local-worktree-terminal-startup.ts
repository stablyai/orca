import type { SetupAttemptRecipe } from '../../../../shared/agent-launch/startup/setup-attempt-recipe'
import {
  provisionArgs,
  callerProvidesInitialSurface,
  setupPlatform,
  ownerSurfacing,
  appendTerminalStartWarning
} from './runtime-worktree-terminal-startup-request'
import { deliverWorktreeInputAfterSetup } from './required-setup-completion'
import { paneIdentity } from '../../terminal/identity/runtime-terminal-pane-identity'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { shouldSeedWorktreePrimaryTerminal } from '../../../../shared/worktree/creation/worktree-first-surface'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/creation/launch-types'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import {
  createSequencedSetupAgentCommands,
  DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import type { TerminalCreateOptions } from '../../terminal/launch/terminal-create-options'
import type { RuntimeManagedWorktreeCreateArgs } from '../creation/runtime-managed-worktree-create-types'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type { WorktreeTerminalProvisioningArgs } from './runtime-worktree-terminal-provisioning'

export type RuntimeLocalWorktreeTerminalPorts = {
  canSpawn: boolean
  bindSetupRecipe?: (workspaceId: string, recipe: SetupAttemptRecipe) => void
  setupPrepared?: (workspaceId: string, required: boolean) => ((success: boolean) => void) | void
  setupFailed?: (workspaceId: string) => void
  waitForSetupTerminalCompletion: (
    handle: string,
    signal?: AbortSignal
  ) => Promise<{ exitCode: number | null }>
  provisionInBackground?: () => boolean
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  pasteDraft: (handle: string, draft: WorktreeStartupDraftPaste) => void
  sendFollowup: (
    handle: string,
    followup: WorktreeStartupFollowup,
    terminal: RuntimeTerminalCreate
  ) => void
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
  defaultTabsProvisioned: boolean
  didSpawnStartup: boolean
  setupTerminalHandle: string | null
  startupTerminalHandle: string | null
  startupTerminalTabId: string | null
  startupTerminalPaneKey: string | null
  startupTerminalPtyId: string | null
}

export async function startRuntimeLocalWorktreeTerminals(args: {
  request: Omit<RuntimeManagedWorktreeCreateArgs, 'repoSelector' | 'name'>
  repo: Pick<Repo, 'id'>
  worktree: Worktree
  setup?: CreateWorktreeResult['setup']
  requiredSetup?: boolean
  inProcessSetup?: Promise<boolean>
  defaultTabs?: CreateWorktreeResult['defaultTabs']
  startup?: WorktreeStartupLaunch
  startupFollowup?: WorktreeStartupFollowup
  /** What a host-built startup was quoted for, or the repair error it fails with. */
  startupLaunchRuntime?: AgentLaunchRuntime | Error
  createdWithAgent?: TuiAgent
  promisedAgentChat?: boolean
  draftPaste?: WorktreeStartupDraftPaste
  warning?: string
  ports: RuntimeLocalWorktreeTerminalPorts
}): Promise<RuntimeLocalWorktreeTerminalStartupResult> {
  const { request, repo, worktree, defaultTabs, startup, ports } = args
  let { setup } = args
  const requiredSetup = args.requiredSetup ?? setup?.waitForAgentStartup === true
  const completeSetup = ports.setupPrepared?.(worktree.id, requiredSetup)
  if (args.inProcessSetup && completeSetup) {
    void args.inProcessSetup.then(completeSetup)
  }
  const shouldActivate = request.activate === true || request.runHooks === true
  let warning = args.warning
  let didSpawnStartup = false
  let didSpawnSetup = false
  let defaultTabsProvisioned = false
  let setupTerminalHandle: string | null = null
  let startupTerminalHandle: string | null = null
  let startupTerminalTabId: string | null = null
  let startupTerminalPaneKey: string | null = null
  let startupTerminalPtyId: string | null = null
  const sequencedStartup = startup
  let wrappedSetupCommand: string | undefined
  let setupCompletionToken: string | undefined
  let startupTerminal: RuntimeTerminalCreate | undefined
  if (setup?.waitForAgentStartup === true) {
    const platform = setupPlatform(setup, process.platform === 'win32' ? 'windows' : 'posix')
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup?.command ?? '',
      platform,
      shell: setup.shell
    })
    ports.bindSetupRecipe?.(worktree.id, {
      runnerScriptPath: setup.runnerScriptPath,
      platform,
      shell: setup.shell,
      nonce: sequenced.completionToken,
      deadline: Date.now() + DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000
    })
    wrappedSetupCommand = sequenced.setupCommand
    setupCompletionToken = sequenced.completionToken
    setup = { ...setup, envVars: { ...setup.envVars, ...sequenced.setupEnv } }
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
        ...(request.startupTitle ? { title: request.startupTitle } : {}),
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
      startupTerminal = terminal
      request.onStartupTerminalCreated?.(terminal)
      if (!setup?.waitForAgentStartup && args.draftPaste) {
        ports.pasteDraft(terminal.handle, args.draftPaste)
      }
      if (!setup?.waitForAgentStartup && args.startupFollowup) {
        ports.sendFollowup(terminal.handle, args.startupFollowup, terminal)
      }
      didSpawnStartup = true
      startupTerminalHandle = terminal.handle
      startupTerminalTabId = terminal.tabId ?? null
      startupTerminalPaneKey = terminal.paneKey ?? null
      startupTerminalPtyId = terminal.ptyId ?? null
    } catch (error) {
      warning = appendTerminalStartWarning(warning, worktree.path, 'startup', error)
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
        defaultTabsProvisioned = Boolean(defaultTabs)
        const provisioned = await ports.provision({
          ...provisionArgs(
            { ...args, setup },
            startupTerminalHandle,
            startupPaneHeld,
            wrappedSetupCommand,
            setupCompletionToken
          ),
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
    defaultTabsProvisioned = Boolean(defaultTabs)
    const provisioning = ports.provision({
      ...provisionArgs(
        { ...args, setup },
        startupTerminalHandle,
        startupPaneHeld,
        wrappedSetupCommand,
        setupCompletionToken
      ),
      surfaceOwner: false
    })
    if (request.awaitTerminalProvisioning || setup?.waitForAgentStartup) {
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
      warning = appendTerminalStartWarning(warning, worktree.path, 'initial', error)
    }
  }
  if (setup?.waitForAgentStartup && startupTerminal && (args.draftPaste || args.startupFollowup)) {
    deliverWorktreeInputAfterSetup({
      ports,
      terminal: startupTerminal,
      setupTerminalHandle,
      didSpawnSetup,
      draftPaste: args.draftPaste,
      startupFollowup: args.startupFollowup,
      agent:
        args.createdWithAgent ?? args.draftPaste?.agent ?? args.startupFollowup?.agent ?? 'Agent'
    })
  }
  if (requiredSetup && !didSpawnSetup && !args.inProcessSetup) {
    ports.setupFailed?.(worktree.id)
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
    defaultTabsProvisioned,
    didSpawnStartup,
    setupTerminalHandle,
    startupTerminalHandle,
    startupTerminalTabId,
    startupTerminalPaneKey,
    startupTerminalPtyId
  }
}
