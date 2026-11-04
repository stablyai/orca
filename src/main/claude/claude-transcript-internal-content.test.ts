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
  at,
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
const contentParts = (row: Record<string, unknown>) => {
  const content = message(row).content
  if (!Array.isArray(content)) {
    throw new Error('recorded content parts missing')
  }
  return content
}

it('imports recorded repair results without inventing outside work or duplicate failed turns', async () => {
  const c = await chat()
  await c.live()
  const translator = createClaudeJournalTranslator({ sink: c.deferred.sink })
  const live = (row: Record<string, unknown>, startsTurn = false) =>
    translator.handle({
      type: 'message',
      sessionId: SESSION,
      message: frame(row),
      ...(startsTurn ? { startsTurn: true } : {}),
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
  expect(c.rows().some((row) => row.startsWith('(continued-outside'))).toBe(false)
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
  expect(c.rows().filter((row) => row === '(continued-outside)')).toHaveLength(1)
  const outside = c.journal
    .snapshot()
    .items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.role === 'assistant' &&
        item.body.blocks.some(
          (block) => block.type === 'text' && block.text === 'real outside answer'
        )
    )!
  const outsideScope = outside.turnScope
  expect(outsideScope?.kind).toBe('turn')
  if (outsideScope?.kind !== 'turn') {
    throw new Error('outside turn missing')
  }
  expect(c.journal.item(outsideScope.turnItemId)?.body).toMatchObject({
    kind: 'turn',
    state: 'completed'
  })
  expect(turns.some((turn) => turn.itemId === outsideScope.turnItemId)).toBe(false)
  expect(
    c.journal.snapshot().items.filter((item) => turns.some((turn) => turn.itemId === item.itemId))
  ).toEqual(turns)
  const caughtUp = c.journal.snapshot()
  expect(await c.open('a1')).toBe(true)
  expect(c.journal.snapshot()).toEqual(caughtUp)
  expect((await c.replay()).snapshot()).toEqual(caughtUp)
})

it.each([false, true])('ignores quiet caveat time with a later prompt: %s', async (laterPrompt) => {
  const c = await chat()
  await c.live()
  await c.write([
    ...chatTurn,
    prompt('outside', 'a1', 'outside work', 10),
    reply('answer', 'outside', 'msg_answer', { type: 'text', text: 'done' }, 11),
    {
      ...prompt('caveat', 'answer', '<local-command-caveat>internal</local-command-caveat>', 60),
      isMeta: true
    },
    ...(laterPrompt ? [prompt('next', 'caveat', 'next request', 70)] : [])
  ])
  expect(await c.open('a1')).toBe(true)
  const turn = c.journal
    .snapshot()
    .items.find((item) => item.body.kind === 'turn' && item.body.turnId === 'outside')
  expect(turn?.body).toMatchObject({
    startedAt: Date.parse(at(10)),
    completedAt: Date.parse(at(11))
  })
})

it('preserves a task boundary without inventing a successor until real output arrives', async () => {
  const c = await chat()
  await c.live()
  const wake = { ...task, ...prompt('wake', 'answer-again', String(message(task).content), 60) }
  await c.write([
    ...chatTurn,
    prompt('outside', 'a1', 'outside work', 10),
    reply('answer', 'outside', 'msg_answer', { type: 'text', text: 'first answer' }, 11),
    { ...prompt('quiet', 'answer', 'quiet metadata', 12), isMeta: true },
    reply('answer-again', 'quiet', 'msg_again', { type: 'text', text: 'continued answer' }, 13),
    wake
  ])
  expect(await c.open('a1')).toBe(true)
  const before = c.journal.snapshot()
  const turn = before.items.find(
    (item) => item.body.kind === 'turn' && item.body.turnId === 'outside'
  )!
  expect(turn.body).toMatchObject({
    state: 'completed',
    startedAt: Date.parse(at(10)),
    completedAt: Date.parse(at(13))
  })
  expect(before.items.filter((item) => item.body.kind === 'turn')).toHaveLength(2)
  expect(c.rows().filter((row) => row === '(continued-outside)')).toHaveLength(1)
  const continued = before.items.find(
    (item) =>
      item.body.kind === 'message' &&
      item.body.role === 'assistant' &&
      item.body.blocks.some((block) => block.type === 'text' && block.text === 'continued answer')
  )!
  expect(continued.turnScope).toEqual({ kind: 'turn', turnItemId: turn.itemId })
  expect(await c.open('a1')).toBe(true)
  expect(c.journal.snapshot()).toEqual(before)
  await c.write([
    reply('wake-answer', 'wake', 'msg_wake', { type: 'text', text: 'wake answer' }, 61)
  ])
  expect(await c.open('a1')).toBe(true)
  const after = c.journal.snapshot()
  const answer = after.items.find(
    (item) =>
      item.body.kind === 'message' &&
      item.body.role === 'assistant' &&
      item.body.blocks.some((block) => block.type === 'text' && block.text === 'wake answer')
  )!
  const scope = answer.turnScope
  expect(scope?.kind).toBe('turn')
  if (scope?.kind !== 'turn') {
    throw new Error('wake turn missing')
  }
  expect(scope.turnItemId).not.toBe(turn.itemId)
  expect(c.journal.item(scope.turnItemId)?.body).toMatchObject({ kind: 'turn', state: 'completed' })
  expect(c.journal.item(turn.itemId)).toEqual(turn)
  expect(after.items.filter((item) => item.body.kind === 'turn')).toHaveLength(3)
  // Each separate catch-up appends one genuine outside stretch.
  expect(c.rows().filter((row) => row === '(continued-outside)')).toHaveLength(2)
  expect(await c.open('a1')).toBe(true)
  expect(c.journal.snapshot()).toEqual(after)
  expect((await c.replay()).snapshot()).toEqual(after)
})

it('keeps mixed task results with their saved caller before an independent reply', async () => {
  const c = await chat()
  await c.live({ tool: true, interrupted: true })
  const saved = c.journal.snapshot()
  const tool = saved.items.find((item) => item.body.kind === 'tool-call')!
  const failed = saved.items.filter((item) => item.body.kind === 'turn')
  await c.write([
    ...chatTurn,
    {
      ...task,
      ...prompt('mixed-task', 'a1', '', 60),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: String(message(task).content) },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'real result' }
        ]
      }
    },
    reply(
      'mixed-answer',
      'mixed-task',
      'msg_mixed',
      { type: 'text', text: 'independent answer' },
      61
    )
  ])
  expect(await c.open('a1')).toBe(true)
  expect(c.journal.item(tool.itemId)).toMatchObject({
    turnScope: tool.turnScope,
    body: { name: 'Read', input: { path: 'original' }, state: 'completed' }
  })
  expect(
    c.journal.snapshot().items.filter((item) => failed.some((old) => old.itemId === item.itemId))
  ).toEqual(failed)
  const answer = c.journal
    .snapshot()
    .items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.role === 'assistant' &&
        item.body.blocks.some(
          (block) => block.type === 'text' && block.text === 'independent answer'
        )
    )!
  expect(answer.turnScope).not.toEqual(tool.turnScope)
  const scope = answer.turnScope
  if (scope?.kind !== 'turn') {
    throw new Error('independent turn missing')
  }
  expect(c.journal.item(scope.turnItemId)?.body).toMatchObject({ kind: 'turn', state: 'completed' })
})

describe('internal content keeps live settlement and semantic siblings', () => {
  it('does not open a turn or acknowledge a pending send, then accepts the real echo/result', async () => {
    const c = await chat()
    const translator = createClaudeJournalTranslator({ sink: c.deferred.sink })
    const live = (row: Record<string, unknown>, startsTurn = false) =>
      translator.handle({
        type: 'message',
        sessionId: SESSION,
        message: frame(row),
        ...(startsTurn ? { startsTurn: true } : {})
      })
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
    expect(translator.currentTurnId).toBe(waiter.sentUuid)
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
        content: [...contentParts(synthetic), ...contentParts(call)]
      }
    })
    const result = rows[2]!
    live({
      ...task,
      message: {
        ...message(task),
        content: [{ type: 'text', text: String(message(task).content) }, ...contentParts(result)]
      }
    })
    live({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    translator.dispose()
    await c.deferred.drained()
    expect(c.rows()).toContain('tool:Bash:failed')
    expect(c.rows()).not.toContain('assistant:No response requested.')
  })
})

it.each(['real-model', 'missing-usage', 'nonzero-usage', 'error', 'empty-error'] as const)(
  'retains %s assistant semantics',
  async (kind) => {
    const c = await chat()
    await c.live()
    const nested = message(synthetic)
    const variant: Record<string, unknown> = {
      ...synthetic,
      parentUuid: 'a1',
      ...(kind === 'error' ? { isApiErrorMessage: true } : {}),
      ...(kind === 'empty-error' ? { error: 'authentication_failed' } : {}),
      message: {
        ...nested,
        ...(kind === 'empty-error' ? { content: [] } : {}),
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
