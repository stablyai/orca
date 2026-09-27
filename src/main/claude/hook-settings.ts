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
import { claudeVersionSupportsSessionEnd } from './claude-session-end-hook-capability'

export type ClaudeCompatibleHookSettings = {
  configDirName: '.claude' | '.openclaude'
  scriptBaseName: 'claude-hook' | 'openclaude-hook'
  usesWindowsCompatLauncher: boolean
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

export const CLAUDE_EVENTS = [
  // Why: SessionStart is the only event a resumed/idle session emits before the
  // first prompt; without it the sidebar row can't exist until the user types (STA-3386).
  {
    eventName: 'SessionStart',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'UserPromptSubmit',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'Stop',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  // Why: OpenClaude skips normal Stop hooks after API/model errors and emits
  // StopFailure instead; without this hook Orca leaves the turn spinning.
  {
    eventName: 'StopFailure',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  // Why: subagent/teammate lifecycle feeds the sidebar's child rows and keeps
  // a pane 'working' while background children outlive the lead's turn.
  // TeammateIdle parks turn-based teammates without trusting their permanently
  // "running" background_tasks entry to gate the pane.
  // Older Claude builds ignore unregistered event names (StopFailure precedent).
  {
    eventName: 'SubagentStart',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'SubagentStop',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'TeammateIdle',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  // Why: PreToolUse gives the dashboard a live readout of the in-flight tool
  // (name + input preview) before it completes.
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  // Why: a manual /compact ends at an idle prompt without emitting Stop, so PostCompact is the only
  // signal that can clear the pane (STA-2915). PreCompact is deliberately NOT registered: it fires
  // before the compact is validated, and an aborted compact emits it alone — mapping it to 'working'
  // would strand the pane exactly as this registration is meant to prevent (STA-4613).
  {
    eventName: 'PostCompact',
    definition: { hooks: [{ type: 'command', command: '' }] }
  }
] as const

const CLAUDE_SESSION_END_EVENT = {
  eventName: 'SessionEnd',
  definition: { hooks: [{ type: 'command', command: '' }] }
} as const

export type ApplyManagedClaudeHooksOptions = {
  claudeVersion?: string
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

// Why (#21514): the registered script is a thin launcher; the hook payload lives in
// this sibling impl so the launcher's missing-payload `{}` stays inside the .cmd.
export function getManagedImplScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${settings.scriptBaseName}-impl.cmd`
}

export function getManagedImplScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getManagedImplScriptFileName(settings))
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
  settings = CLAUDE_HOOK_SETTINGS
): HookCommandConfig {
  if (process.platform !== 'win32' || !settings.usesWindowsCompatLauncher) {
    return buildManagedCommandHook(getManagedCommand(scriptPath, { neutralJsonWhenMissing: true }))
  }
  return getWindowsManagedLifecycleHook(scriptPath)
}

// Why: some Claude-compatible consumers ignore `args`, so the invocation must be self-contained.
export function getWindowsManagedLifecycleHook(scriptPath: string): HookCommandConfig {
  // Why (#18875): the encoded launcher cost a PowerShell start-up per hook event. The direct
  // path needs no host gate (#21514): a bare path parses under cmd.exe, bash, and PowerShell
  // alike — only the removed `||` required bash-vs-PowerShell discrimination, and a
  // shell-level fallback would mask a host that cannot spawn `.cmd` at all (WSL bash).
  const directCommand = wrapWindowsDirectCmdHookCommand(scriptPath)
  if (directCommand) {
    return { type: 'command', command: directCommand, timeout: MANAGED_HOOK_TIMEOUT_SECONDS }
  }
  const scriptFileName = win32.basename(scriptPath)
  // Why: runtime profile resolution keeps the managed entry portable across users (STA-3348).
  const quotedRelativePath = quotePowerShellLiteral(`.orca\\agent-hooks\\${scriptFileName}`)
  // Why: compat consumers require neutral JSON even when the managed script is missing (#14818).
  const innerCommand =
    `$scriptPath = Join-Path $env:USERPROFILE ${quotedRelativePath}; ` +
    'if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { & $scriptPath; exit $LASTEXITCODE }; ' +
    "[Console]::In.ReadToEnd() | Out-Null; Write-Output '{}'; exit 0"
  return {
    type: 'command',
    command: wrapWindowsPowerShellEncodedCommand(innerCommand),
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS
  }
}

export function hasSameManagedHookInvocation(
  actual: HookCommandConfig,
  expected: HookCommandConfig
): boolean {
  return (
    actual.command === expected.command &&
    JSON.stringify(actual.args ?? []) === JSON.stringify(expected.args ?? [])
  )
}

export function getRemoteManagedCommand(scriptPath: string): string {
  return getManagedCommand(scriptPath, { neutralJsonWhenMissing: true })
}

export function applyManagedHooks(
  config: HooksConfig,
  hook: HookCommandConfig,
  scriptFileName = getManagedScriptFileName(),
  options: ApplyManagedClaudeHooksOptions = {}
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const sessionEndCapable = claudeVersionSupportsSessionEnd(options.claudeVersion)
  const events = sessionEndCapable ? [...CLAUDE_EVENTS, CLAUDE_SESSION_END_EVENT] : CLAUDE_EVENTS

  for (const event of events) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [hook]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  if (!sessionEndCapable) {
    const current = Array.isArray(nextHooks.SessionEnd) ? nextHooks.SessionEnd : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks.SessionEnd
    } else {
      nextHooks.SessionEnd = cleaned
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
