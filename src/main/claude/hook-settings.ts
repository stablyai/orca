import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  isPlainObject,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsGitBashHookCommand,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'

export type ClaudeCompatibleHookSettings = {
  configDirName: '.claude' | '.openclaude'
  scriptBaseName: 'claude-hook' | 'openclaude-hook'
}

export const CLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.claude',
  scriptBaseName: 'claude-hook'
}

export const OPENCLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.openclaude',
  scriptBaseName: 'openclaude-hook'
}

export const CLAUDE_EVENTS = [
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: OpenClaude skips normal Stop hooks after API/model errors and emits
  // StopFailure instead; without this hook Orca leaves the turn spinning.
  { eventName: 'StopFailure', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: subagent/teammate lifecycle feeds the sidebar's child rows and keeps
  // a pane 'working' while background children outlive the lead's turn.
  // TeammateIdle parks turn-based teammates without trusting their permanently
  // "running" background_tasks entry to gate the pane.
  // Older Claude builds ignore unregistered event names (StopFailure precedent).
  { eventName: 'SubagentStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SubagentStop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'TeammateIdle', definition: { hooks: [{ type: 'command', command: '' }] } },
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
  }
] as const

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

export function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsGitBashHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function applyManagedHooks(
  config: HooksConfig,
  command: string,
  scriptFileName = getManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of CLAUDE_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [buildManagedCommandHook(command)]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
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
