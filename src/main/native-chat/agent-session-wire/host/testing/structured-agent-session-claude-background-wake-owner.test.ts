import { expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { claudeFrame as frame } from '../../../../claude/structured/claude-structured-session-test-support'
import {
  backgroundWakeCapture,
  FIRST_PROMPT
} from '../../../../claude/claude-captured-fold-steer-frames.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { fixture, laneDrained } from './structured-agent-session-claude-stop-contract-test-fixture'
import {
  dispatch,
  eventually,
  openTurn,
  send,
  sendUnechoed
} from './structured-agent-session-claude-stop-contract-test-actions'

async function turns() {
  await laneDrained()
  await fixture.host.flushStreamedEvents(SESSION)
  return (await fixture.host.journalSnapshot(SESSION)).items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn ? [turn] : []
  })
}

// The wake frames are CLI 2.1.280's; B's place among them is constructed, not captured.
it.each([
  ['handed over before the first result, without receipts', 3_406, null],
  ['handed over before the first result, reported queued', 3_406, 'queued'],
  ['handed over after the first turn ended', Infinity, null]
])(
  'keeps an unrelated background wake provider-owned when a follow-up is %s',
  async (_label, handoffAt, receipt) => {
    const connection = fixture.claude.connections[0]!
    await send(FIRST_PROMPT)
    await eventually(() => expect(connection.sent).toHaveLength(1))
    const first = connection.sent[0]!
    const capture = backgroundWakeCapture({
      sessionId: String(first.session_id),
      first: String(first.uuid),
      steer: 'unused'
    })
    for (const event of capture.firstTurn.filter((event) => event.at < handoffAt)) {
      frame(connection, event.frame)
    }
    await laneDrained()
    const followUp = await send('What is seven times eight?')
    await eventually(() => expect(connection.sent).toHaveLength(2))
    const written = connection.sent[1]!
    if (receipt) {
      frame(connection, { type: 'command_lifecycle', state: receipt, command_uuid: written.uuid })
    }
    for (const event of capture.firstTurn.filter((event) => event.at >= handoffAt)) {
      frame(connection, event.frame)
    }
    for (const event of capture.wake) {
      frame(connection, event.frame)
    }

    const wake = (await turns()).at(-1)
    expect(wake).toMatchObject({ turnId: 'task_updated-17547', state: 'completed' })
    expect(wake?.userItemId).not.toBe(agentJournalSubmissionKey(followUp))
    expect(wake?.userItemId).not.toContain(String(written.uuid))
    expect((await dispatch(followUp)).state).not.toBe('accepted')

    // The follow-up's own echo opens its turn.
    frame(connection, { ...written, parent_tool_use_id: null })
    expect((await turns()).at(-1)).toMatchObject({ turnId: written.uuid, state: 'running' })
    expect(await dispatch(followUp)).toMatchObject({ state: 'accepted' })
  }
)

it.each([
  ['plural', (uuid: unknown) => ({ user_message_uuids: [uuid] })],
  ['singular', (uuid: unknown) => ({ user_message_uuid: uuid })]
])(
  'settles a follow-up its own %s result names without letting it own the next send',
  async (_label, names) => {
    const connection = fixture.claude.connections[0]!
    await openTurn(connection, 'Say the word A.')
    const uuidA = connection.sent.at(-1)!.uuid
    const followUp = await sendUnechoed(connection)
    const uuidB = connection.sent.at(-1)!.uuid
    frame(connection, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-a',
      user_message_uuids: [uuidA]
    })
    // B's own result arrives with no echo, init or output of B.
    frame(connection, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-b',
      ...names(uuidB)
    })
    expect(await dispatch(followUp)).toMatchObject({ state: 'accepted' })

    const next = await send('Say the word C.')
    await eventually(() => expect(connection.sent).toHaveLength(3))
    const written = connection.sent.at(-1)!
    frame(connection, { ...written, parent_tool_use_id: null })
    expect((await turns()).filter((turn) => turn.state === 'running')).toEqual([
      expect.objectContaining({ turnId: written.uuid })
    ])
    expect(await dispatch(next)).toMatchObject({ state: 'accepted' })
  }
)
