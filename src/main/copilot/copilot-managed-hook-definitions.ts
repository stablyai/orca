import {
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { wrapWindowsDirectCmdHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { getWindowsSystem32Path } from '../agent-hooks/windows-powershell-hook-launcher'

// Why: Copilot's user-level hook files can use VS Code-compatible PascalCase
// names, which match the event vocabulary already normalized by Orca's hook
// server and avoid wrapper-side event remapping.
export const COPILOT_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  // Why: GitHub's current reference documents subagentStart with only the
  // camelCase payload shape. The wrapper passes the event name separately, so
  // Orca can normalize it without depending on a PascalCase payload.
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
  // Why an argument, not the hook `env` map: every Copilot version runs the command text, so the
  // event survives runners that ignore `env`, and each event keeps a distinct managed command.
  const direct = wrapWindowsDirectCmdHookCommand(scriptPath)
  // Why `/d`: Copilot runs the `powershell` field only under PowerShell, which starts a bare .cmd
  // without `/d`, so a printing cmd AutoRun would land ahead of the `{}` Copilot parses.
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
