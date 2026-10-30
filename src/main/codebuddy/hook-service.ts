import type { ClaudeManagedHookPlan } from '../claude/claude-managed-hook-events'
import { ClaudeHookService } from '../claude/hook-service'

export const CODEBUDDY_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Notification'
] as const

export const CODEBUDDY_MANAGED_HOOK_PLAN: ClaudeManagedHookPlan = {
  install: CODEBUDDY_HOOK_EVENTS.map((eventName) => ({ eventName, definition: {} })),
  retire: [],
  statusLine: 'leave'
}

export const codebuddyHookService = new ClaudeHookService({
  agent: 'codebuddy',
  source: 'codebuddy',
  displayName: 'CodeBuddy',
  settings: {
    configDirName: '.codebuddy',
    scriptBaseName: 'codebuddy-hook',
    // No `shell: 'powershell'`: CodeBuddy runs that as bare `pwsh`, absent on stock Windows (#27182).
    usesWindowsCompatLauncher: true
  },
  hookPlan: CODEBUDDY_MANAGED_HOOK_PLAN
})
