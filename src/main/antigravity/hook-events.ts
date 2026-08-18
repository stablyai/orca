export const ANTIGRAVITY_HOOK_BUNDLE_NAME = 'orca-status'

export const ANTIGRAVITY_EVENTS = [
  {
    eventName: 'PreInvocation',
    schema: 'direct',
    windowsWrapperFileName: 'antigravity-pre-invocation.cmd'
  },
  {
    eventName: 'PostInvocation',
    schema: 'direct',
    windowsWrapperFileName: 'antigravity-post-invocation.cmd'
  },
  { eventName: 'Stop', schema: 'direct', windowsWrapperFileName: 'antigravity-stop.cmd' },
  // Why: Antigravity requires PreToolUse hooks to make permission decisions.
  // Orca's hook is observational, so installing there can block user tools.
  {
    eventName: 'PostToolUse',
    schema: 'tool',
    windowsWrapperFileName: 'antigravity-post-tool-use.cmd'
  }
] as const

export type AntigravityEvent = (typeof ANTIGRAVITY_EVENTS)[number]

export const ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES = [
  'antigravity-hook.sh',
  'antigravity-hook.cmd',
  ...ANTIGRAVITY_EVENTS.map((event) => event.windowsWrapperFileName)
] as const
