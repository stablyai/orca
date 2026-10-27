import { ClaudeHookService } from '../claude/hook-service'
import type { ClaudeManagedHookPlan } from '../claude/claude-managed-hook-events'

// Qwen's hook enum is authoritative; Claude's version table and statusline do not apply.
export const QWEN_CODE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop'
] as const

export const QWEN_CODE_MANAGED_HOOK_PLAN: ClaudeManagedHookPlan = {
  install: QWEN_CODE_HOOK_EVENTS.map((eventName) => ({ eventName, definition: {} })),
  retire: [],
  statusLine: 'leave'
}

export const qwenCodeHookService = new ClaudeHookService({
  agent: 'qwen-code',
  source: 'qwen-code',
  displayName: 'Qwen Code',
  settings: {
    configDirName: '.qwen',
    scriptBaseName: 'qwen-code-hook',
    usesWindowsCompatLauncher: true,
    windowsHookShell: 'powershell'
  },
  hookPlan: QWEN_CODE_MANAGED_HOOK_PLAN
})
