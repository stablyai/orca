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

/** The no-op reply the managed script prints, for paths that skip the script. */
export function getAntigravityNoOpStdout(eventName: string): string | undefined {
  // Empty PreToolUse output leaves the decision to agy; any JSON, even {}, overrides its reviewer.
  if (eventName === 'PreToolUse') {
    return undefined
  }
  return eventName === 'Stop' ? '{"decision":""}' : '{}'
}

export type AntigravityEvent = (typeof ANTIGRAVITY_EVENTS)[number]

export const ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES = [
  'antigravity-hook.sh',
  'antigravity-hook.cmd',
  ...ANTIGRAVITY_EVENTS.map((event) => event.windowsWrapperFileName)
] as const
