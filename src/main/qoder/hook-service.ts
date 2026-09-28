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
  events: QODER_HOOK_EVENTS.map((eventName) => ({ eventName, definition: {} }))
})
