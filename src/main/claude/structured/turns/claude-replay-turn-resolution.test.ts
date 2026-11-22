import { expect, it } from 'vitest'
import { resolveClaudeReplayTurn } from './claude-replay-turn-resolution'
import { waitForReplay } from '../dispatch/claude-structured-dispatch-waiters'
import type { ClaudeLateDispatchOutcome, ClaudeSession } from '../claude-structured-session-state'

const SESSION = '00000000-0000-4000-8000-00000000c1a0'
const SENT = 'ec94ea32-e87c-4cef-9ff1-be319d2e77a5'
const RESULT = '5bfd911d-c26b-4598-bc75-959a8a2fd86d'

const lifecycle = (state: string): Record<string, unknown> => ({
  type: 'command_lifecycle',
  command_uuid: SENT,
  state,
  session_id: SESSION
})

// Frames Claude Code 2.1.330 sent for a prompt stopped while its UserPromptSubmit hook ran, trimmed to what is read.
// The result precedes lifecycle `cancelled`; the reverse order would release the send in doubt instead.
const stopFrames: Record<string, unknown>[] = [
  lifecycle('queued'),
  lifecycle('started'),
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: '86166d82-2504-4a44-8f86-c94a7c967db4'
  },
  {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: SESSION,
    uuid: RESULT,
    terminal_reason: 'aborted_streaming',
    user_message_uuid: SENT,
    user_message_uuids: [SENT]
  },
  lifecycle('cancelled')
]

function stop() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the uuid-correlated path reads only these fields; translator is optional.
  const session = {
    providerSessionId: SESSION,
    dispatchSequence: 0,
    dispatchWaiters: [],
    retiredDispatchWaiters: []
  } as unknown as ClaudeSession
  const { promise } = waitForReplay(session, false, SENT, 'key', 'client-1', null)
  const settled: ClaudeLateDispatchOutcome[] = []
  for (const frame of stopFrames) {
    resolveClaudeReplayTurn(session, frame, (outcome) => settled.push(outcome))
  }
  return { settled, promise, session }
}

it('settles a prompt Claude dropped on Stop as unrun, never under the result frame uuid', async () => {
  const { settled, promise, session } = stop()
  expect(settled).toHaveLength(1)
  expect(settled[0]).toMatchObject({ clientMessageId: 'client-1', state: 'rejected', unrun: true })
  expect(JSON.stringify(settled)).not.toContain(RESULT)
  expect(await promise).toBeNull()
  expect(session.dispatchWaiters).toHaveLength(0)
})
