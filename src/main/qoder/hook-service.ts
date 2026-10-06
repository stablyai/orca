import type { ClaudeManagedHookPlan } from '../claude/claude-managed-hook-events'
import { ClaudeHookService } from '../claude/hook-service'

// Qoder documents Claude-shaped hooks at https://docs.qoder.com/cli/hooks.
export const QODER_HOOK_EVENTS = [
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
  'PostCompact'
] as const

// Why: Qoder's own CLI reads these events, so Claude's version table never applies; the statusline
// usage feed is Claude-only.
export const QODER_MANAGED_HOOK_PLAN: ClaudeManagedHookPlan = {
  install: QODER_HOOK_EVENTS.map((eventName) => ({ eventName, definition: {} })),
  retire: [],
  statusLine: 'leave'
}

export const qoderHookService = new ClaudeHookService({
  agent: 'qoder',
  source: 'qoder',
  displayName: 'Qoder CLI',
  settings: {
    configDirName: '.qoder',
    scriptBaseName: 'qoder-hook',
    usesWindowsCompatLauncher: true,
    windowsHookShell: 'powershell'
  },
  hookPlan: QODER_MANAGED_HOOK_PLAN
})

export const qoderCnHookService = new ClaudeHookService({
  agent: 'qoder-cn',
  source: 'qoder-cn',
  displayName: 'Qoder CLI China',
  settings: {
    configDirName: '.qoder-cn',
    scriptBaseName: 'qoder-cn-hook',
    usesWindowsCompatLauncher: true,
    windowsHookShell: 'powershell'
  },
  hookPlan: QODER_MANAGED_HOOK_PLAN
})
