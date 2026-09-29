import { homedir } from 'node:os'
import { basename, extname, join, win32 } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  removeManagedCommands,
  wrapWindowsPowerShellEncodedCommand,
  type HookCommandConfig,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'
import { wrapRuntimeHomeHookCommand } from '../agent-hooks/runtime-home-hook-command'
import { wrapWindowsDirectCmdHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { isGitBashAvailable } from '../git-bash'
import type { ClaudeManagedHookPlan } from './claude-managed-hook-events'

export type ClaudeCompatibleHookSettings = {
  configDirName: '.claude' | '.openclaude' | '.qoder' | '.codebuddy'
  scriptBaseName: 'claude-hook' | 'openclaude-hook' | 'qoder-hook' | 'codebuddy-hook'
  usesWindowsCompatLauncher: boolean
  windowsHookShell?: 'powershell'
}

export const CLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.claude',
  scriptBaseName: 'claude-hook',
  usesWindowsCompatLauncher: true
}

export const OPENCLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.openclaude',
  scriptBaseName: 'openclaude-hook',
  usesWindowsCompatLauncher: false
}

export function getConfigPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return join(homedir(), settings.configDirName, 'settings.json')
}

export function getStatusLineScriptBaseName(settings = CLAUDE_HOOK_SETTINGS): string {
  return settings.scriptBaseName.replace(/-hook$/, '-statusline')
}

export function getStatusLineScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return process.platform === 'win32'
    ? `${getStatusLineScriptBaseName(settings)}.cmd`
    : getPosixStatusLineScriptFileName(settings)
}

export function getPosixStatusLineScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${getStatusLineScriptBaseName(settings)}.sh`
}

export function getStatusLineScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getStatusLineScriptFileName(settings))
}

export function getManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return process.platform === 'win32'
    ? `${settings.scriptBaseName}.cmd`
    : getPosixManagedScriptFileName(settings)
}

export function getPosixManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${settings.scriptBaseName}.sh`
}

export function getManagedScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getManagedScriptFileName(settings))
}

export function getRemoteConfigPath(remoteHome: string, settings = CLAUDE_HOOK_SETTINGS): string {
  return `${remoteHome.replace(/\/$/, '')}/${settings.configDirName}/settings.json`
}

export function getManagedCommand(
  scriptPath: string,
  options: { neutralJsonWhenMissing?: boolean } = {}
): string {
  const scriptFileName = basename(scriptPath)
  const extension = extname(scriptFileName)
  return wrapRuntimeHomeHookCommand(
    extension ? scriptFileName.slice(0, -extension.length) : scriptFileName,
    options
  )
}

export function getManagedLifecycleHook(
  scriptPath: string,
  settings = CLAUDE_HOOK_SETTINGS,
  options: WindowsManagedLifecycleHookOptions = {}
): HookCommandConfig {
  if (process.platform !== 'win32' || !settings.usesWindowsCompatLauncher) {
    return buildManagedCommandHook(getManagedCommand(scriptPath, { neutralJsonWhenMissing: true }))
  }
  if (settings.windowsHookShell === 'powershell') {
    return {
      type: 'command',
      command: getWindowsPowerShellLifecycleCommand(scriptPath),
      shell: 'powershell',
      timeout: MANAGED_HOOK_TIMEOUT_SECONDS
    }
  }
  return getWindowsManagedLifecycleHook(scriptPath, options)
}

export type WindowsManagedLifecycleHookOptions = { gitBashAvailable?: boolean }

// Why: some Claude-compatible consumers ignore `args`, so the invocation must be self-contained.
export function getWindowsManagedLifecycleHook(
  scriptPath: string,
  options: WindowsManagedLifecycleHookOptions = {}
): HookCommandConfig {
  // Why (#18875): the encoded launcher cost a PowerShell start-up per hook event. Take the direct
  // path only where the host can parse `||` — Git Bash can, Windows PowerShell 5.1 cannot.
  const directCommand =
    (options.gitBashAvailable ?? isGitBashAvailable())
      ? wrapWindowsDirectCmdHookCommand(scriptPath)
      : null
  if (directCommand) {
    return { type: 'command', command: directCommand, timeout: MANAGED_HOOK_TIMEOUT_SECONDS }
  }
  return {
    type: 'command',
    command: wrapWindowsPowerShellEncodedCommand(getWindowsPowerShellLifecycleCommand(scriptPath)),
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS
  }
}

function getWindowsPowerShellLifecycleCommand(scriptPath: string): string {
  const scriptFileName = win32.basename(scriptPath)
  const quotedRelativePath = quotePowerShellLiteral(`.orca\\agent-hooks\\${scriptFileName}`)
  return (
    `$scriptPath = Join-Path $env:USERPROFILE ${quotedRelativePath}; ` +
    'if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { & $scriptPath; exit $LASTEXITCODE }; ' +
    "[Console]::In.ReadToEnd() | Out-Null; Write-Output '{}'; exit 0"
  )
}

export function hasSameManagedHookInvocation(
  actual: HookCommandConfig,
  expected: HookCommandConfig
): boolean {
  return (
    actual.command === expected.command &&
    actual.shell === expected.shell &&
    JSON.stringify(actual.args ?? []) === JSON.stringify(expected.args ?? [])
  )
}

export function getRemoteManagedCommand(scriptPath: string): string {
  return getManagedCommand(scriptPath, { neutralJsonWhenMissing: true })
}

export function applyManagedHooks(
  config: HooksConfig,
  hook: HookCommandConfig,
  scriptFileName: string,
  plan: ClaudeManagedHookPlan
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of plan.install) {
    const current = nextHooks[event.eventName]
    const cleaned = Array.isArray(current) ? removeManagedCommands(current, isManagedCommand) : []
    const definition: HookDefinition = { ...event.definition, hooks: [hook] }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  for (const event of plan.retire) {
    const current = nextHooks[event.eventName]
    if (!Array.isArray(current) || current.length === 0) {
      continue
    }
    const cleaned = removeManagedCommands(current, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[event.eventName]
    } else {
      nextHooks[event.eventName] = cleaned
    }
  }

  return { ...config, hooks: nextHooks }
}

export type StatusLineSlotState = 'managed' | 'user' | 'empty'

// Why: install policy needs "user owns the slot" vs "slot is empty" vs "ours" — an empty slot
// after a prior install means the user deleted the managed entry, which install must respect.
export function getStatusLineSlotState(
  config: HooksConfig,
  scriptFileName = getStatusLineScriptFileName()
): StatusLineSlotState {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const current = config.statusLine
  const currentCommand =
    isPlainObject(current) && typeof current.command === 'string' ? current.command : null
  if (!currentCommand) {
    return 'empty'
  }
  return isManagedCommand(currentCommand) ? 'managed' : 'user'
}

// Why: records that the managed statusline was installed once, so a later empty slot reads as user opt-out.
export function getStatusLineInstallMarkerPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(`${getStatusLineScriptBaseName(settings)}.installed`)
}

// Why: statusLine is a single settings slot, not a hooks array — never overwrite a
// user-owned status line; the usage feed then simply falls back to the OAuth poll.
export function applyManagedStatusLine(
  config: HooksConfig,
  command: string,
  scriptFileName = getStatusLineScriptFileName()
): HooksConfig {
  if (getStatusLineSlotState(config, scriptFileName) === 'user') {
    return config
  }
  return { ...config, statusLine: { type: 'command', command } }
}

export function removeManagedStatusLine(
  config: HooksConfig,
  scriptFileName = getStatusLineScriptFileName()
): { config: HooksConfig; changed: boolean } {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const current = config.statusLine
  const currentCommand =
    isPlainObject(current) && typeof current.command === 'string' ? current.command : null
  if (!currentCommand || !isManagedCommand(currentCommand)) {
    return { config, changed: false }
  }
  const next = { ...config }
  delete next.statusLine
  return { config: next, changed: true }
}

export function removeManagedHooks(
  config: HooksConfig,
  scriptFileName = getManagedScriptFileName()
): {
  config: HooksConfig
  changed: boolean
} {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  let changed = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) {
      changed = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  return {
    config: { ...config, hooks: nextHooks },
    changed
  }
}
