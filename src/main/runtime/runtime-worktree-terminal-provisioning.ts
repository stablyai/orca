import { randomUUID } from 'node:crypto'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { shouldSeedWorktreePrimaryTerminal } from '../../shared/worktree-first-surface'
import { buildObservedSetupCommand } from './orchestration/setup-completion-signal'
import { buildSetupRunnerCommand } from '../../shared/setup-runner-command'

type TerminalResult = { handle: string }
export type WorktreeProvisionTerminalOptions = {
  title?: string
  command?: string
  env?: Record<string, string>
  activate?: boolean
  surfaceOwner?: false
}

export type WorktreeTerminalProvisioningHost = {
  canSpawn: () => boolean
  createTerminal: (
    selector: string,
    options: WorktreeProvisionTerminalOptions
  ) => Promise<TerminalResult>
  // Why: keyed by the terminal; the host resolves its tab, so no create path can forget to pass it.
  // The title is the tab's own, as the window's setTabCustomTitle sets it, never the pane's title.
  setTabTitle: (handle: string, title: string) => Promise<void>
  setTabColor: (handle: string, color: string) => Promise<void>
  getPtyId: (handle: string) => string | undefined
  recordSetupCompletionToken: (ptyId: string, token: string) => void
}

export type WorktreeTerminalProvisioningArgs = {
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
  // Why: setup and startup must use the same wrapper when startup waits for setup.
  wrappedSetupCommand?: string
  surfaceOwner?: false
}

export async function createWorktreeDefaultTabTerminals(
  host: WorktreeTerminalProvisioningHost,
  selector: string,
  worktreeId: string,
  defaultTabs: CreateWorktreeResult['defaultTabs'] | undefined,
  surfacing: { surfaceOwner?: false } = {},
  startupHandle?: string
): Promise<string[]> {
  if (!defaultTabs || defaultTabs.tabs.length === 0 || !host.canSpawn()) {
    return []
  }
  const [first, ...rest] = defaultTabs.tabs
  // The agent the create started is the workspace's first tab, as the window lays it out: it takes
  // the first template's title and color, and that template's command does not run beside it.
  if (startupHandle && first) {
    await dressAsDefaultTab(host, worktreeId, startupHandle, first)
  }
  const handles: string[] = []
  for (const template of startupHandle ? rest : defaultTabs.tabs) {
    try {
      const command = template.command?.trim()
      const terminal = await host.createTerminal(selector, {
        ...(template.title ? { title: template.title } : {}),
        ...(command && defaultTabs.runCommands ? { command } : {}),
        ...surfacing
      })
      handles.push(terminal.handle)
      await dressAsDefaultTab(host, worktreeId, terminal.handle, template)
    } catch (error) {
      console.warn(`[worktree-create] Failed to create default tab for ${worktreeId}:`, error)
    }
  }
  return handles
}

// Why: a tab's look is bookkeeping; a failure is logged and never costs the tab, the other field,
// or the create.
async function dressAsDefaultTab(
  host: WorktreeTerminalProvisioningHost,
  worktreeId: string,
  handle: string,
  template: NonNullable<CreateWorktreeResult['defaultTabs']>['tabs'][number]
): Promise<void> {
  if (template.title) {
    try {
      await host.setTabTitle(handle, template.title)
    } catch (error) {
      console.warn(`[worktree-create] Failed to title a default tab for ${worktreeId}:`, error)
    }
  }
  if (template.color) {
    try {
      await host.setTabColor(handle, template.color)
    } catch (error) {
      console.warn(`[worktree-create] Failed to color a default tab for ${worktreeId}:`, error)
    }
  }
}

export async function provisionWorktreeTerminals(
  host: WorktreeTerminalProvisioningHost,
  args: WorktreeTerminalProvisioningArgs
): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }> {
  if (!host.canSpawn()) {
    return { setupSpawned: false, setupTerminalHandle: null }
  }
  const surfacing = args.surfaceOwner === false ? { surfaceOwner: false as const } : {}
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
        args.observeSetupCompletion && !args.wrappedSetupCommand ? randomUUID() : null
      const observed = completionToken
        ? buildObservedSetupCommand(
            args.setup.runnerScriptPath,
            args.setupCommandPlatform,
            completionToken,
            args.setup.shell
          )
        : null
      const command =
        args.wrappedSetupCommand ??
        observed?.command ??
        buildSetupRunnerCommand(
          args.setup.runnerScriptPath,
          args.setupCommandPlatform,
          args.setup.shell
        )
      const env = { ...args.setup.envVars, ...observed?.env }
      const setupTerminal = await host.createTerminal(args.worktreeSelector, {
        title: 'Setup',
        command,
        env,
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
  return { setupSpawned, setupTerminalHandle }
}
