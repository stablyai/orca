// Subscribe only to Cursor hooks needed for spinner and turn detection.
// Exclude process-boundary session hooks, which can reset the submitted-turn prompt cache.
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

const CURSOR_HOOK_RESPONSES = {
  beforeSubmitPrompt: '{"continue":true}',
  stop: '{}',
  preToolUse: '{"permission":"allow"}',
  postToolUse: '{}',
  postToolUseFailure: '{}',
  beforeShellExecution: '{"permission":"allow"}',
  beforeMCPExecution: '{"permission":"allow"}',
  afterAgentResponse: '{}'
} satisfies Record<CursorEvent, string>

export function getCursorHookResponse(eventName: CursorEvent): string {
  return CURSOR_HOOK_RESPONSES[eventName]
}
