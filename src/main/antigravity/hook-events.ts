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
  // PreToolUse is the only pre-tool signal Antigravity emits; without it panes show a bare "Working" spinner (#12898).
  {
    eventName: 'PreToolUse',
    schema: 'tool',
    windowsWrapperFileName: 'antigravity-pre-tool-use.cmd'
  },
  {
    eventName: 'PostToolUse',
    schema: 'tool',
    windowsWrapperFileName: 'antigravity-post-tool-use.cmd'
  }
] as const

// Why: Antigravity requires a decision on PreToolUse and reads silence as deny (#2426). Of the documented values
// only "ask" defers to the user's permission config — "allow" would auto-approve every tool call Orca observes.
export const ANTIGRAVITY_PRE_TOOL_USE_DECISION = '{"decision":"ask"}'

export type AntigravityEvent = (typeof ANTIGRAVITY_EVENTS)[number]

export const ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES = [
  'antigravity-hook.sh',
  'antigravity-hook.cmd',
  ...ANTIGRAVITY_EVENTS.map((event) => event.windowsWrapperFileName)
] as const
