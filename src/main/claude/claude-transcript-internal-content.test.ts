import { describe, expect, it } from 'vitest'
import capture from './__fixtures__/claude-plugin-recovery.json'
import { asRecord } from '../ai-vault/session-scanner-values'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { resolveClaudeReplayTurn } from './claude-replay-turn-resolution'
import { dispatchClaudeTurn } from './structured/claude-structured-dispatch'
import {
  sessionFor,
  userMessage,
  userReplayFrame
} from './structured/claude-structured-dispatch-test-support'
import {
  SESSION,
  SID,
  chat,
  chatTurn,
  prompt,
  reply
} from './claude-transcript-catch-up-test-support'

// Claude 2.1.316: background wake and two resumed, interrupted tool calls.
const rows: Record<string, unknown>[] = capture.map((row, index) => ({
  ...row,
  sessionId: SID,
  ...(index === 0 ? { parentUuid: 'a1' } : {})
}))
const frame = (row: Record<string, unknown>) => ({
  ...row,
  session_id: SID,
  parent_tool_use_id: null
})
const synthetic = rows[3]!
const task = rows[0]!
const message = (row: Record<string, unknown>) => asRecord(row.message)!

it('imports recorded repair results without inventing outside work or duplicate failed turns', async () => {
  const c = await chat()
  await c.live()
  const translator = createClaudeJournalTranslator({ sink: c.deferred.sink })
  const live = (row: Record<string, unknown>, startsTurn = false) =>
    translator.handle({
      type: 'message',
      sessionId: SESSION,
      message: frame(row),
      startsTurn,
      observedAt: 4_000
    })
  live({
    type: 'system',
    subtype: 'task_started',
    task_id: 'bobbnxies',
    task_type: 'local_bash',
    description: 'background work'
  })
  live({ type: 'system', subtype: 'task_notification', task_id: 'bobbnxies', status: 'completed' })
  live(task)
  live(rows[1]!)
  const end = () =>
    translator.handle({
      type: 'ended',
      sessionId: SESSION,
      reason: 'crash',
      failure: agentSessionFailureFact('pluginInputRequired'),
      observedAt: 5_000
    })
  end()
  const localPrompt = rows[4]!
  await c.journal.appendSubmission({
    clientMessageId: 'retry',
    body: userMessage([{ type: 'text', text: 'retry' }]),
    payloadFingerprint: 'retry',
    fence: 1
  })
  await c.journal.resolveDispatch({
    clientMessageId: 'retry',
    state: 'accepted',
    providerIdentity: { provider: 'claude', sessionId: SID, uuid: String(localPrompt.uuid) },
    fence: 1
  })
  live(localPrompt, true)
  live(rows[5]!)
  end()
  translator.dispose()
  await c.deferred.drained()
  const before = c.journal.snapshot()
  const turns = before.items.filter((item) => item.body.kind === 'turn')
  await c.write([...chatTurn, ...rows])
  expect(await c.open('a1')).toBe(true)
  const after = c.journal.snapshot()
  expect(after.items.filter((item) => item.body.kind === 'turn')).toEqual(turns)
  for (const row of [task, synthetic, rows[7]!]) {
    expect(
      c.journal.item(
        agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: String(row.uuid) })
      )
    ).toBeNull()
  }
  const tools = after.items.filter((item) => item.body.kind === 'tool-call')
  expect(tools).toHaveLength(2)
  for (const tool of tools) {
    expect(tool.body).toMatchObject({ name: 'Bash', state: 'failed' })
    const original = before.items.find((item) => item.itemId === tool.itemId)!
    expect(tool.turnScope).toEqual(original.turnScope)
    expect(tool.body.kind === 'tool-call' && tool.body.input).toEqual(
      original.body.kind === 'tool-call' && original.body.input
    )
  }
  expect(c.rows()).not.toContain('(continuedOutside)')
  expect(await c.open('a1')).toBe(true)
  expect(c.journal.snapshot()).toEqual(after)
  expect((await c.replay()).snapshot()).toEqual(after)

  const outsideTask = { ...task, uuid: 'outside-task', parentUuid: rows[7]!.uuid }
  await c.write([
    outsideTask,
    reply(
      'outside-answer',
      'outside-task',
      'msg_outside',
      { type: 'text', text: 'real outside answer' },
      10
    )
  ])
  expect(await c.open('a1')).toBe(true)
  expect(c.rows()).toContain('assistant:real outside answer')
  expect(c.rows().filter((row) => row === '(continuedOutside)')).toHaveLength(1)
})

describe('internal content keeps live settlement and semantic siblings', () => {
  it('does not open a turn or acknowledge a pending send, then accepts the real echo/result', async () => {
    const c = await chat()
    const translator = createClaudeJournalTranslator({ sink: c.deferred.sink })
    const live = (row: Record<string, unknown>, startsTurn = false) =>
      translator.handle({ type: 'message', sessionId: SESSION, message: frame(row), startsTurn })
    live(synthetic)
    live(task, true)
    expect(translator.currentTurnId).toBeNull()
    const session = sessionFor()
    session.providerSessionId = SID
    const sent = await dispatchClaudeTurn(session, {
      sessionId: SESSION,
      clientMessageId: 'real-send',
      body: userMessage([{ type: 'text', text: String(message(task).content) }])
    })
    const waiter = session.dispatchWaiters[0]!
    const internalEcho = { ...frame(task), uuid: waiter.sentUuid }
    expect(resolveClaudeReplayTurn(session, internalEcho)).toBeNull()
    expect(session.dispatchWaiters).toHaveLength(1)
    const realEcho = {
      ...userReplayFrame(waiter.sentUuid, String(message(task).content)),
      session_id: SID
    }
    expect(resolveClaudeReplayTurn(session, realEcho)).toMatchObject({
      clientMessageId: 'real-send'
    })
    expect(sent).toEqual({ state: 'admitted' })
    live(realEcho, true)
    live(synthetic)
    const result = { type: 'result', subtype: 'success', session_id: SID, uuid: 'real-result' }
    live(result)
    expect(session.dispatchWaiters).toHaveLength(0)
    expect(translator.currentTurnId).toBeNull()
    translator.dispose()
    await c.deferred.drained()
    expect(c.rows()).not.toContain('assistant:No response requested.')
  })

  it('keeps mixed injected tool results and synthetic tool siblings', async () => {
    const c = await chat()
    const translator = createClaudeJournalTranslator({ sink: c.deferred.sink })
    const live = (row: Record<string, unknown>) =>
      translator.handle({ type: 'message', sessionId: SESSION, message: frame(row) })
    const call = rows[1]!
    live({
      ...synthetic,
      message: {
        ...message(synthetic),
        content: [
          ...(message(synthetic).content as unknown[]),
          ...(message(call).content as unknown[])
        ]
      }
    })
    const result = rows[2]!
    live({
      ...task,
      message: {
        ...message(task),
        content: [
          { type: 'text', text: String(message(task).content) },
          ...(message(result).content as unknown[])
        ]
      }
    })
    live({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    translator.dispose()
    await c.deferred.drained()
    expect(c.rows()).toContain('tool:Bash:failed')
    expect(c.rows()).not.toContain('assistant:No response requested.')
  })
})

it.each(['real-model', 'missing-usage', 'nonzero-usage', 'error'] as const)(
  'retains %s assistant content with the same text',
  async (kind) => {
    const c = await chat()
    await c.live()
    const nested = message(synthetic)
    const variant = {
      ...synthetic,
      parentUuid: 'a1',
      ...(kind === 'error' ? { isApiErrorMessage: true } : {}),
      message: {
        ...nested,
        ...(kind === 'real-model' ? { model: 'claude-opus-5-5' } : {}),
        ...(kind === 'missing-usage' ? { usage: undefined } : {}),
        ...(kind === 'nonzero-usage'
          ? { usage: { ...asRecord(nested.usage), output_tokens: 1 } }
          : {})
      }
    }
    await c.write([...chatTurn, variant])
    expect(await c.open('a1')).toBe(true)
    expect(
      c.journal.item(
        agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: String(variant.uuid) })
      )
    ).not.toBeNull()
  }
)

it.each([undefined, { kind: 'human' }, { kind: 'future-origin' }])(
  'retains canonical human text with origin %j',
  async (origin) => {
    const c = await chat()
    await c.live()
    const human = { ...prompt('external-human', 'a1', String(message(task).content), 10), origin }
    await c.write([...chatTurn, human])
    expect(await c.open('a1')).toBe(true)
    expect(
      c.journal.item(
        agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'external-human' })
      )?.body
    ).toMatchObject({ kind: 'message', role: 'user' })
  }
)
