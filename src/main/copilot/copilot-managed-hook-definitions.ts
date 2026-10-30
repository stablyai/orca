import {
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { wrapWindowsDirectCmdHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { getWindowsSystem32Path } from '../agent-hooks/windows-powershell-hook-launcher'

// VS Code-compatible PascalCase names reuse the hook server's event normalization.
export const COPILOT_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  // This event is documented only in camelCase; the wrapper supplies its name for normalization.
  'subagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'ErrorOccurred',
  'PermissionRequest',
  'Notification'
] as const

export function getManagedCommand(scriptPath: string, eventName: string): string {
  if (process.platform !== 'win32') {
    return wrapPosixHookCommand(scriptPath, { ORCA_COPILOT_HOOK_EVENT: eventName })
  }
  // Arguments survive runners that ignore hook env maps and keep managed commands distinct per event.
  const direct = wrapWindowsDirectCmdHookCommand(scriptPath)
  // /d suppresses cmd AutoRun output that would corrupt the {} response Copilot parses.
  return direct
    ? `${getWindowsSystem32Path('cmd.exe')} /d /c ${direct} ${eventName}`
    : wrapWindowsHookCommand(scriptPath, { ORCA_COPILOT_HOOK_EVENT: eventName })
}

export function getManagedHookDefinition(command: string): HookDefinition {
  return process.platform === 'win32'
    ? { type: 'command', powershell: command, timeoutSec: 5 }
    : { type: 'command', bash: command, timeoutSec: 5 }
}

export function definitionHasCurrentCommand(definition: HookDefinition, command: string): boolean {
  return (
    definition.command === command ||
    definition.bash === command ||
    definition.powershell === command ||
    (Array.isArray(definition.hooks) && definition.hooks.some((hook) => hook.command === command))
  )
}

export function definitionHasStaleManagedCommand(
  definition: HookDefinition,
  currentCommand: string | null,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  const commands = [definition.command, definition.bash, definition.powershell]
  if (commands.some((command) => isManagedCommand(command) && command !== currentCommand)) {
    return true
  }
  return (
    Array.isArray(definition.hooks) &&
    definition.hooks.some(
      (hook) => isManagedCommand(hook.command) && hook.command !== currentCommand
    )
  )
}

export function definitionsChanged(before: HookDefinition[], after: HookDefinition[]): boolean {
  return (
    before.length !== after.length ||
    after.some((definition, index) => definition !== before[index])
  )
}
