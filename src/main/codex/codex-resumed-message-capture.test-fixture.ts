import type { CodexThreadItem } from './codex-structured-item-translation'

/** Captured after `thread/resume` of the live turn in codex-structured-item-translation.test.ts:
 *  message ids restart at 1 and the command execution is no longer present. */
export const CODEX_RESUMED_MESSAGE_CAPTURE: CodexThreadItem[] = [
  { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'list the files' }] },
  { type: 'agentMessage', id: 'item-2', text: 'Let me look.' },
  { type: 'agentMessage', id: 'item-3', text: 'Two files.' }
]
