// Process-boundary session hooks reset the submitted-turn cache; subscribe only to turn events.
export const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterAgentResponse'
] as const

export type CursorEvent = (typeof CURSOR_EVENTS)[number]

// Orca only observes: permission hooks answer `{}` (no decision) so Cursor's own approval still applies.
const CURSOR_HOOK_RESPONSES = {
  beforeSubmitPrompt: '{"continue":true}',
  stop: '{}',
  preToolUse: '{}',
  postToolUse: '{}',
  postToolUseFailure: '{}',
  beforeShellExecution: '{}',
  beforeMCPExecution: '{}',
  afterAgentResponse: '{}'
} satisfies Record<CursorEvent, string>

export function getCursorHookResponse(eventName: CursorEvent): string {
  return CURSOR_HOOK_RESPONSES[eventName]
}
