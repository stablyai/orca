import {
  claudeWithSavedHistory,
  restoredChatWithBlockedRecovery
} from './claude-structured-session-open.test-fixture'
import { readTestHostJournal } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { afterEach, expect, it, vi } from 'vitest'
import * as jsonlImport from '../../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import * as transcriptCatchUp from '../../transcripts/claude-transcript-catch-up'
import {
  chat,
  closeClaudeCatchUpChats,
  SESSION,
  PROVIDER
} from '../../transcripts/claude-transcript-catch-up.test-support'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
  await closeClaudeCatchUpChats()
})

async function openWithBlockedRecovery(outcome: 'success' | 'drop' | 'error' = 'success') {
  const c = await chat('batch')
  const claude = claudeWithSavedHistory({
    providerSessionId: PROVIDER,
    cwd: c.cwd,
    claudeConfigDir: c.config
  })
  const { adapter } = claude
  if (outcome === 'drop') {
    const replace = c.deferred.sink.tryReplaceHistory!.bind(c.deferred.sink)
    vi.spyOn(c.deferred.sink, 'tryReplaceHistory').mockImplementationOnce((replacement) => {
      Atomics.store(replacement.operation.guard.permit, 0, 0)
      return replace(replacement)
    })
  }
  const blocked = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<transcriptCatchUp.ClaudeTranscriptCatchUpOutcome>()
  const prepare = jsonlImport.prepareJsonlTranscriptImport
  vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockImplementationOnce(async (input) => {
    const prepared = await prepare(input)
    blocked.resolve(input.signal!)
    await release.promise
    if (outcome === 'error') {
      throw new Error('transcript read failed')
    }
    return prepared
  })
  const catchUp = transcriptCatchUp.catchUpClaudeTranscript
  vi.spyOn(transcriptCatchUp, 'catchUpClaudeTranscript').mockImplementation(async (input) => {
    const outcome = await catchUp(input)
    if (input.mode === 'recovery') {
      finished.resolve(outcome)
    }
    return outcome
  })
  let opened: Promise<unknown> | undefined
  cleanups.push(async () => {
    release.resolve()
    await opened?.catch(() => {})
    await adapter.closeAll()
  })
  const acquired = await adapter.acquire({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(PROVIDER, null)
    },
    fence: 1,
    spawnToken: 'catch-up-open',
    events: c.deferred.sink
  })
  opened = adapter.open({
    sessionId: SESSION,
    fence: 1,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  await opened
  adapter.startupSettled(SESSION, acquired.acquisitionGeneration)
  return {
    ...c,
    claude,
    adapter,
    opened,
    blocked: blocked.promise,
    release,
    finished: finished.promise
  }
}

it('opens the chat while capacity recovery is blocked, then installs the recent history', async () => {
  const c = await openWithBlockedRecovery()
  await c.blocked
  await expect(c.opened).resolves.toMatchObject({ newConversation: false })
  expect(await c.items()).not.toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({ presentation: 'continued-outside-recent' })
    })
  )
  c.release.resolve()
  expect(await c.finished).toBe(true)
  const items = await c.items()
  expect(items).toContainEqual(
    expect.objectContaining({
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Distinctive newest outside answer' }]
      }
    })
  )
  expect(items.at(-1)).toMatchObject({
    itemId:
      'legacy:claude:chat-catch-up:continued-outside%3Acapacity%3Aprovider-catch-up%3Aold-leaf',
    body: {
      kind: 'status',
      presentation: 'continued-outside-recent',
      text: 'This chat was continued in a separate CLI session. Showing recent history only.'
    }
  })
  expect(
    items.filter(
      ({ body }) => body.kind === 'status' && body.presentation === 'continued-outside-recent'
    )
  ).toHaveLength(1)
})

it.each(['success', 'drop', 'error'] as const)(
  'holds sends until capacity recovery settles with %s',
  async (outcome) => {
    const c = await openWithBlockedRecovery(outcome)
    await c.blocked
    await c.opened
    expect(c.adapter.holdsDispatch(SESSION)).toBe('history-catch-up')
    const sent = c.adapter.dispatch({
      sessionId: SESSION,
      fence: 1,
      clientMessageId: 'live-prompt',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Keep my live turn' }]
      }
    })
    expect(c.claude.connections[0]!.sent).toEqual([])
    c.release.resolve()
    expect(await c.finished).toBe(outcome === 'success')
    await expect(sent).resolves.toMatchObject({ state: 'admitted' })
    expect(c.adapter.holdsDispatch(SESSION)).toBe(false)
    expect(
      (await c.items()).some(
        (item) =>
          item.body.kind === 'status' && item.body.presentation === 'continued-outside-recent'
      )
    ).toBe(outcome === 'success')
  }
)

it('releases the recovery hold when the session closes and drops the replacement', async () => {
  const c = await openWithBlockedRecovery()
  const signal = await c.blocked
  await c.opened
  expect(c.adapter.holdsDispatch(SESSION)).toBe('history-catch-up')
  await c.adapter.closeAll()
  expect(signal.aborted).toBe(true)
  expect(c.adapter.holdsDispatch(SESSION)).toBe(false)
  const cursor = await c.journal.reads.physicalCursor()
  c.release.resolve()
  expect(await c.finished).toBe(false)
  await c.deferred.sink.written?.()
  expect(await c.journal.reads.physicalCursor()).toEqual(cursor)
})

it('keeps the send that acquires a restored chat queued until recovery commits, then delivers it once', async () => {
  const c = await restoredChatWithBlockedRecovery(cleanups)
  const delivered = Promise.withResolvers<void>()
  const catchingUp = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const unsubscribe = c.host.subscribeStatus({
    id: 'catch-up-phase',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        if (event.session.hostExecutionPhase === 'catching-up') {
          catchingUp.resolve()
        } else if (event.session.hostExecutionPhase === 'ready') {
          ready.resolve()
        }
      }
    }
  })
  cleanups.unshift(async () => unsubscribe())
  const dispatch = c.adapter.dispatch
  vi.spyOn(c.adapter, 'dispatch').mockImplementation(async (input) => {
    const outcome = await dispatch(input)
    delivered.resolve()
    return outcome
  })
  const clientOperationId = '1800000000000-00000000000000000000000000000001'
  expect(await c.send(clientOperationId)).toMatchObject({ ok: true })
  await c.blocked
  await catchingUp.promise
  expect(c.host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('catching-up')
  const waiting = await readTestHostJournal(c.host, SESSION)
  const queued = waiting.submissions.find(
    (submission) => submission.clientMessageId === clientOperationId
  )
  expect(queued).toBeDefined()
  expect(queued?.handedOverAt).toBeUndefined()
  expect(c.claude.connections[0]!.sent).toEqual([])
  c.release.resolve()
  await delivered.promise
  await ready.promise
  expect(c.host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
  const recovered = await readTestHostJournal(c.host, SESSION)
  expect(recovered.items).toContainEqual(
    expect.objectContaining({
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Distinctive newest outside answer' }]
      }
    })
  )
  expect(
    recovered.items
      .filter(({ body }) => body.kind === 'message' || body.kind === 'status')
      .slice(-2)
      .map(({ body }) => body)
  ).toEqual([
    {
      kind: 'status',
      presentation: 'continued-outside-recent',
      text: 'This chat was continued in a separate CLI session. Showing recent history only.'
    },
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Keep my original send' }]
    }
  ])
  expect(
    c.claude.connections[0]!.sent.filter((message) =>
      JSON.stringify(message).includes('Keep my original send')
    )
  ).toHaveLength(1)
})

it('delivers a send interrupted by closing during recovery before a newer send after reopen, once each', async () => {
  const c = await restoredChatWithBlockedRecovery(cleanups, true)
  expect(await c.send('1800000000000-00000000000000000000000000000001')).toMatchObject({ ok: true })
  await c.blocked
  expect(c.adapter.holdsDispatch(SESSION)).toBe('history-catch-up')
  expect(c.claude.connections[0]!.sent).toEqual([])
  const recovery = c.adapter.pendingDelivery(SESSION)
  await c.host.close(SESSION, 'user-close')
  c.release.resolve()
  await recovery
  const reopened = await c.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(reopened).toMatchObject({
    ok: true,
    page: { queuedMessages: [expect.objectContaining({ state: 'waiting' })] }
  })
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const deliveries = [first, second]
  const dispatch = c.adapter.dispatch
  vi.spyOn(c.adapter, 'dispatch').mockImplementation(async (input) => {
    const outcome = await dispatch(input)
    deliveries.shift()?.resolve()
    return outcome
  })
  expect(
    await c.send('1800000000000-00000000000000000000000000000002', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'My newer send' }]
    })
  ).toMatchObject({ ok: true })
  await first.promise
  const connection = c.claude.connections[1]!
  connection.handlers.onMessage?.({
    type: 'result',
    subtype: 'success',
    session_id: '819cf9f8-e43c-4ad7-b50f-54aa158a726a',
    uuid: 'first-result',
    num_turns: 1
  })
  await second.promise
  await readTestHostJournal(c.host, SESSION)
  expect(
    c.claude.connections.flatMap((child) =>
      child.sent.filter((message) => message.type === 'user').map((message) => message.message)
    )
  ).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'Keep my original send' }] },
    { role: 'user', content: [{ type: 'text', text: 'My newer send' }] }
  ])
})
