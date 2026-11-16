import { createWorktreeDefaultTabTerminals } from './runtime-worktree-default-tabs'
export { createWorktreeDefaultTabTerminals } from './runtime-worktree-default-tabs'
import type { TerminalCreateOptions } from '../../terminal/launch/terminal-create-options'
import type { SetupAttemptRecipe } from '../../../../shared/agent-launch/startup/setup-attempt-recipe'
import {
  createSequencedSetupAgentCommands,
  DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { randomUUID } from 'node:crypto'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { shouldSeedWorktreePrimaryTerminal } from '../../../../shared/worktree/creation/worktree-first-surface'
import { buildObservedSetupCommand } from '../../orchestration/workers/launch/setup-completion-signal'
import { buildSetupRunnerCommand } from '../../../../shared/agent-launch/startup/setup-runner-command'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { DefaultTerminalTab } from '../../../../shared/workspace-layout/workspace-layout-command-types'

type TerminalResult = { handle: string }
export type WorktreeProvisionTerminalOptions = Pick<
  TerminalCreateOptions,
  | 'tabId'
  | 'leafId'
  | 'cwd'
  | 'title'
  | 'command'
  | 'setupRequired'
  | 'setupCompletionToken'
  | 'env'
  | 'activate'
  | 'surfaceOwner'
  | 'keepPaneOnStartFailure'
  | 'wslUserAct'
>

export type WorktreeTerminalProvisioningHost = {
  refuseSetup?: (workspaceId: string) => void
  bindSetupRecipe?: (workspaceId: string, recipe: SetupAttemptRecipe) => void
  canSpawn: () => boolean
  createTerminal: (
    selector: string,
    options: WorktreeProvisionTerminalOptions
  ) => Promise<TerminalResult>
  setTabTitle: (handle: string, title: string) => Promise<void>
  setTabColor: (handle: string, color: string) => Promise<void>
  getSetupTerminalTitle?: () => string
  applyDefaultTabs?: (
    worktreeId: string,
    tabs: DefaultTerminalTab[]
  ) => Promise<readonly { tabId: string }[] | null>
  getPtyId: (handle: string) => string | undefined
  recordSetupCompletionToken: (ptyId: string, token: string) => void
}

// What every terminal of this create shares: who surfaces it, and whether the create was the user's act (E9).
export type TerminalSurfacing = { surfaceOwner?: false; wslUserAct?: true }

export type WorktreeTerminalProvisioningArgs = {
  /** The create was the user's act: its terminals may start a stopped WSL distro. */
  wslUserAct?: true
  worktreeSelector: string
  worktreeId: string
  worktreePath: string
  setup?: CreateWorktreeResult['setup']
  defaultTabs?: CreateWorktreeResult['defaultTabs']
  primaryTerminalHandle?: string | null
  hasStartupTerminal: boolean
  setupOnly?: boolean
  callerProvidesSurface?: boolean
  startupNeedsTerminal?: boolean
  setupCommandPlatform: 'windows' | 'posix'
  observeSetupCompletion?: boolean
  setupCompletionToken?: string
  // Why: setup and startup must use the same wrapper when startup waits for setup.
  wrappedSetupCommand?: string
  surfaceOwner?: false
}

export async function provisionWorktreeTerminals(
  host: WorktreeTerminalProvisioningHost,
  args: WorktreeTerminalProvisioningArgs
): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }> {
  if (!host.canSpawn()) {
    if (args.setup?.waitForAgentStartup) {
      host.refuseSetup?.(args.worktreeId)
    }
    return { setupSpawned: false, setupTerminalHandle: null }
  }
  const required = args.setup?.waitForAgentStartup
    ? createSequencedSetupAgentCommands({
        runnerScriptPath: args.setup.runnerScriptPath,
        platform: args.setupCommandPlatform,
        shell: args.setup.shell,
        nonce: args.setupCompletionToken,
        startupCommand: ''
      })
    : undefined
  if (required && args.setup) {
    host.bindSetupRecipe?.(args.worktreeId, {
      runnerScriptPath: args.setup.runnerScriptPath,
      platform: args.setupCommandPlatform,
      shell: args.setup.shell,
      nonce: required.completionToken,
      deadline: Date.now() + DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000
    })
  }
  const surfacing: TerminalSurfacing = {
    ...(args.surfaceOwner === false ? { surfaceOwner: false as const } : {}),
    ...(args.wslUserAct ? { wslUserAct: true as const } : {})
  }
  let setupSpawned = false
  let setupTerminalHandle: string | null = null
  let shellSkippedForSetup = false
  try {
    const setupOnly = args.setup !== undefined && args.setupOnly === true
    const defaultHandles = await createWorktreeDefaultTabTerminals(
      host,
      args.worktreeSelector,
      args.worktreeId,
      setupOnly ? undefined : args.defaultTabs,
      surfacing,
      args.hasStartupTerminal ? (args.primaryTerminalHandle ?? undefined) : undefined
    )
    const primaryHandle = args.primaryTerminalHandle ?? defaultHandles[0] ?? null
    if (!args.hasStartupTerminal && !primaryHandle && setupOnly) {
      shellSkippedForSetup = true
    }
    if (
      !setupOnly &&
      shouldSeedWorktreePrimaryTerminal({
        hasPrimarySurface: args.hasStartupTerminal || primaryHandle !== null,
        callerProvidesSurface: args.callerProvidesSurface === true,
        startupNeedsTerminal: args.startupNeedsTerminal
      })
    ) {
      await host.createTerminal(args.worktreeSelector, surfacing)
    }
    if (args.setup) {
      const completionToken =
        required?.completionToken ??
        args.setupCompletionToken ??
        (args.observeSetupCompletion || args.setup.waitForAgentStartup ? randomUUID() : null)
      const observed =
        completionToken && !required && !args.wrappedSetupCommand
          ? buildObservedSetupCommand(
              args.setup.runnerScriptPath,
              args.setupCommandPlatform,
              completionToken,
              args.setup.shell
            )
          : null
      const command =
        args.wrappedSetupCommand ??
        required?.setupCommand ??
        observed?.command ??
        buildSetupRunnerCommand(
          args.setup.runnerScriptPath,
          args.setupCommandPlatform,
          args.setup.shell
        )
      const env = { ...args.setup.envVars, ...observed?.env, ...required?.setupEnv }
      const setupTerminal = await host.createTerminal(args.worktreeSelector, {
        ...(args.setup.cwd ? { cwd: args.setup.cwd } : {}),
        title: host.getSetupTerminalTitle?.() ?? 'Setup',
        command,
        env,
        ...(completionToken
          ? {
              setupCompletionToken: completionToken,
              setupRequired: args.setup.waitForAgentStartup === true
            }
          : {}),
        // Keep failed setup in its pane to show the failure.
        ...(ORCA_LAYOUT_OWNER_IS_MAIN ? { keepPaneOnStartFailure: true as const } : {}),
        ...surfacing
      })
      setupTerminalHandle = setupTerminal.handle
      setupSpawned = true
      const ptyId = host.getPtyId(setupTerminal.handle)
      if (completionToken && ptyId) {
        host.recordSetupCompletionToken(ptyId, completionToken)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[worktree-create] Failed to create setup/default terminals for ${args.worktreePath}: ${message}`
    )
    // A cleared choice needs a shell after failed Setup only when this create owes the surface.
    if (
      shellSkippedForSetup &&
      !setupSpawned &&
      shouldSeedWorktreePrimaryTerminal({
        hasPrimarySurface: false,
        callerProvidesSurface: args.callerProvidesSurface === true,
        startupNeedsTerminal: args.startupNeedsTerminal
      })
    ) {
      await host
        .createTerminal(args.worktreeSelector, surfacing)
        .catch((fallbackError: unknown) => {
          console.warn(
            `[worktree-create] Failed to open a fallback terminal for ${args.worktreePath}:`,
            fallbackError
          )
        })
    }
  }
  if (args.setup?.waitForAgentStartup && !setupSpawned) {
    host.refuseSetup?.(args.worktreeId)
  }
  return { setupSpawned, setupTerminalHandle }
}
