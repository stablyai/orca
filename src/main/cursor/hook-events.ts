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
