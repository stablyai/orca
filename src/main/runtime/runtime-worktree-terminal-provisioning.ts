import { randomUUID } from 'node:crypto'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { buildObservedSetupCommand } from './orchestration/setup-completion-signal'
import { buildSetupRunnerCommand } from '../../shared/setup-runner-command'
import type { RuntimeStore } from './runtime-store-contract'

type TerminalResult = { handle: string; tabId?: string | null }
export type WorktreeProvisionTerminalOptions = {
  title?: string
  command?: string
  env?: Record<string, string>
  direction?: 'horizontal' | 'vertical'
  activate?: boolean
  surfaceOwner?: false
}

export type WorktreeTerminalProvisioningHost = {
  canSpawn: () => boolean
  createTerminal: (
    selector: string,
    options: WorktreeProvisionTerminalOptions
  ) => Promise<TerminalResult>
  splitTerminal: (
    handle: string,
    options: WorktreeProvisionTerminalOptions
  ) => Promise<TerminalResult>
  setTabColor: (worktreeId: string, tabId: string, color: string) => Promise<void>
  getSettings: () => ReturnType<RuntimeStore['getSettings']>
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
  surfacing: { surfaceOwner?: false } = {}
): Promise<string[]> {
  if (!defaultTabs || defaultTabs.tabs.length === 0 || !host.canSpawn()) {
    return []
  }
  const handles: string[] = []
  for (const template of defaultTabs.tabs) {
    try {
      const command = template.command?.trim()
      const terminal = await host.createTerminal(selector, {
        ...(template.title ? { title: template.title } : {}),
        ...(command && defaultTabs.runCommands ? { command } : {}),
        ...surfacing
      })
      handles.push(terminal.handle)
      if (template.color && terminal.tabId) {
        await host.setTabColor(worktreeId, terminal.tabId, template.color)
      }
    } catch (error) {
      console.warn(`[worktree-create] Failed to create default tab for ${worktreeId}:`, error)
    }
  }
  return handles
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
  try {
    const defaultHandles = await createWorktreeDefaultTabTerminals(
      host,
      args.worktreeSelector,
      args.worktreeId,
      args.defaultTabs,
      surfacing
    )
    let primaryHandle = args.primaryTerminalHandle ?? defaultHandles[0] ?? null
    const setupLaunchMode =
      (host.getSettings() as Partial<Pick<GlobalSettings, 'setupScriptLaunchMode'>>)
        .setupScriptLaunchMode ?? 'new-tab'
    if (!args.hasStartupTerminal && !primaryHandle) {
      primaryHandle = (await host.createTerminal(args.worktreeSelector, surfacing)).handle
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
      const shouldSplit =
        primaryHandle &&
        (setupLaunchMode === 'split-vertical' || setupLaunchMode === 'split-horizontal')
      const setupTerminal = await (shouldSplit
        ? host.splitTerminal(primaryHandle, {
            direction: setupLaunchMode === 'split-horizontal' ? 'horizontal' : 'vertical',
            command,
            env,
            activate: false,
            ...surfacing
          })
        : host.createTerminal(args.worktreeSelector, {
            title: 'Setup',
            command,
            env,
            ...surfacing
          }))
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
  }
  return { setupSpawned, setupTerminalHandle }
}
