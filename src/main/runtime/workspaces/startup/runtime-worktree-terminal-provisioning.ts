import { randomUUID } from 'node:crypto'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { shouldSeedWorktreePrimaryTerminal } from '../../../../shared/worktree/creation/worktree-first-surface'
import { buildObservedSetupCommand } from '../../orchestration/workers/launch/setup-completion-signal'
import {
  applySetupAutoCloseSetting,
  buildSetupRunnerCommand
} from '../../../../shared/agent-launch/startup/setup-runner-command'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { DefaultTerminalTab } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { TerminalCreateOptions } from '../../terminal/launch/terminal-create-options'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

type TerminalResult = { handle: string }
type TerminalSurfacing = Pick<
  TerminalCreateOptions,
  'surfaceOwner' | 'wslUserAct' | 'terminalImageViewerSupported'
>

export type WorktreeProvisionTerminalOptions = TerminalSurfacing & {
  /** The pane main already wrote (layout-owner build): the terminal starts in it. */
  tabId?: string
  leafId?: string
  cwd?: string
  title?: string
  command?: string
  env?: Record<string, string>
  activate?: boolean
  keepPaneOnStartFailure?: true
}

export type WorktreeTerminalProvisioningHost = {
  canSpawn: () => boolean
  createTerminal: (
    selector: string,
    options: WorktreeProvisionTerminalOptions
  ) => Promise<TerminalResult>
  // Resolve tab from the terminal handle so callers cannot omit ownership; title belongs to the tab, not its pane.
  setTabTitle: (handle: string, title: string) => Promise<void>
  setTabColor: (handle: string, color: string) => Promise<void>
  // Desktop hosts inject localized copy; Node hosts retain the English fallback.
  getSetupTerminalTitle?: () => string
  /** The tabs main made; none when the workspace already had them; null when main refused. */
  applyDefaultTabs?: (
    worktreeId: string,
    tabs: DefaultTerminalTab[]
  ) => Promise<readonly { tabId: string }[] | null>
  // Read only for the setup auto-close setting; absent means off.
  getSettings?: () => ReturnType<RuntimeStore['getSettings']>
  getPtyId: (handle: string) => string | undefined
  recordSetupCompletionToken: (ptyId: string, token: string) => void
}

export type WorktreeTerminalProvisioningArgs = TerminalSurfacing & {
  worktreeSelector: string
  worktreeId: string
  worktreePath: string
  setup?: CreateWorktreeResult['setup']
  defaultTabs?: CreateWorktreeResult['defaultTabs']
  /** Approved commands for tabs the create already opened: start them as new tabs, not deduped by the layout. */
  defaultTabsBesideExisting?: true
  primaryTerminalHandle?: string | null
  hasStartupTerminal: boolean
  setupOnly?: boolean
  callerProvidesSurface?: boolean
  startupNeedsTerminal?: boolean
  setupCommandPlatform: 'windows' | 'posix'
  observeSetupCompletion?: boolean
  // Why: setup and startup must use the same wrapper when startup waits for setup.
  wrappedSetup?: { command: string; completionToken?: string }
}

export async function createWorktreeDefaultTabTerminals(
  host: WorktreeTerminalProvisioningHost,
  selector: string,
  worktreeId: string,
  defaultTabs: CreateWorktreeResult['defaultTabs'] | undefined,
  surfacing: TerminalSurfacing = {},
  startupHandle?: string,
  besideExisting?: true
): Promise<DefaultTabTerminals> {
  if (!defaultTabs || defaultTabs.tabs.length === 0 || !host.canSpawn()) {
    return { handles: [], failed: false }
  }
  const [first, ...rest] = defaultTabs.tabs
  // Startup occupies the first default tab: inherit its title/color without also running its template command.
  if (startupHandle && first) {
    await dressAsDefaultTab(host, worktreeId, startupHandle, first)
  }
  if (ORCA_LAYOUT_OWNER_IS_MAIN && host.applyDefaultTabs && !besideExisting) {
    return startDefaultTabsInLayout(
      host,
      host.applyDefaultTabs,
      { selector, worktreeId, defaultTabs, surfacing },
      startupHandle ? rest : defaultTabs.tabs
    )
  }
  const handles: string[] = []
  let failed = false
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
      failed = true
      console.warn(`[worktree-create] Failed to create default tab for ${worktreeId}:`, error)
    }
  }
  return { handles, failed }
}

/** `failed`: a tab didn't start, which an approved-setup run reports instead of claiming success. */
type DefaultTabTerminals = { handles: string[]; failed: boolean }

async function startDefaultTabsInLayout(
  host: WorktreeTerminalProvisioningHost,
  applyDefaultTabs: NonNullable<WorktreeTerminalProvisioningHost['applyDefaultTabs']>,
  {
    selector,
    worktreeId,
    defaultTabs,
    surfacing
  }: {
    selector: string
    worktreeId: string
    defaultTabs: NonNullable<CreateWorktreeResult['defaultTabs']>
    surfacing: TerminalSurfacing
  },
  templates: NonNullable<CreateWorktreeResult['defaultTabs']>['tabs']
): Promise<DefaultTabTerminals> {
  const panes = templates.map((template) => ({
    template,
    tab: {
      tabId: randomUUID(),
      leafId: randomUUID(),
      ...(template.title ? { title: template.title } : {}),
      ...(template.color ? { color: template.color } : {})
    }
  }))
  const createdTabs = await applyDefaultTabs(
    worktreeId,
    panes.map(({ tab }) => tab)
  )
  if (!createdTabs) {
    console.warn(`[worktree-create] Main refused the default tabs for ${worktreeId}`)
    return { handles: [], failed: true }
  }
  // Start only newly created defaults; existing workspaces receive none again.
  const created = new Set(createdTabs.map(({ tabId }) => tabId))
  const handles: string[] = []
  let failed = false
  for (const { template, tab } of panes.filter(({ tab }) => created.has(tab.tabId))) {
    const command = template.command?.trim()
    try {
      const terminal = await host.createTerminal(selector, {
        tabId: tab.tabId,
        leafId: tab.leafId,
        ...(template.title ? { title: template.title } : {}),
        ...(command && defaultTabs.runCommands ? { command } : {}),
        ...surfacing
      })
      handles.push(terminal.handle)
    } catch (error) {
      failed = true
      console.warn(`[worktree-create] Failed to start a default tab for ${worktreeId}:`, error)
    }
  }
  return { handles, failed }
}

// Appearance failures must not cost the tab, the other field or workspace creation.
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
): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null; failed?: true }> {
  if (!host.canSpawn()) {
    return { setupSpawned: false, setupTerminalHandle: null, failed: true }
  }
  const surfacing: TerminalSurfacing = {
    ...(args.surfaceOwner === false ? { surfaceOwner: false as const } : {}),
    ...(args.wslUserAct ? { wslUserAct: true as const } : {}),
    ...(args.terminalImageViewerSupported !== undefined
      ? { terminalImageViewerSupported: args.terminalImageViewerSupported }
      : {})
  }
  let setupSpawned = false
  let setupTerminalHandle: string | null = null
  let shellSkippedForSetup = false
  let failed = false
  try {
    const setupOnly = args.setup !== undefined && args.setupOnly === true
    const defaultTabTerminals = await createWorktreeDefaultTabTerminals(
      host,
      args.worktreeSelector,
      args.worktreeId,
      setupOnly ? undefined : args.defaultTabs,
      surfacing,
      args.hasStartupTerminal ? (args.primaryTerminalHandle ?? undefined) : undefined,
      args.defaultTabsBesideExisting
    )
    failed = defaultTabTerminals.failed
    const primaryHandle = args.primaryTerminalHandle ?? defaultTabTerminals.handles[0] ?? null
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
      // A wrapped setup prints the token its wrapper was built with.
      const completionToken = !args.observeSetupCompletion
        ? null
        : args.wrappedSetup
          ? (args.wrappedSetup.completionToken ?? null)
          : randomUUID()
      const observed =
        completionToken && !args.wrappedSetup
          ? buildObservedSetupCommand(
              args.setup.runnerScriptPath,
              args.setupCommandPlatform,
              completionToken,
              args.setup.shell
            )
          : null
      const command = applySetupAutoCloseSetting(
        args.wrappedSetup?.command ??
          observed?.command ??
          buildSetupRunnerCommand(
            args.setup.runnerScriptPath,
            args.setupCommandPlatform,
            args.setup.shell
          ),
        args.setupCommandPlatform,
        args.setup.shell,
        host.getSettings?.()
      )
      const env = { ...args.setup.envVars, ...observed?.env }
      const setupTerminal = await host.createTerminal(args.worktreeSelector, {
        ...(args.setup.cwd ? { cwd: args.setup.cwd } : {}),
        title: host.getSetupTerminalTitle?.() ?? 'Setup',
        command,
        env,
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
    failed = true
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
  return { setupSpawned, setupTerminalHandle, ...(failed ? { failed: true as const } : {}) }
}
