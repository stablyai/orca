import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  adapterFor as claudeAdapter,
  claudeFrame,
  fakeClaude,
  identityFor as claudeIdentity
} from '../../claude/claude-structured-session-test-support'
import {
  acquireReadyCodexForTest,
  adapterFor as codexAdapter,
  fakeCodex,
  identityFor as codexIdentity,
  THREAD_ID
} from '../../codex/codex-structured-session-adapter-fixture'
import {
  openAcpAdapterRig,
  sendHello,
  shellCall
} from '../../acp/acp-structured-adapter.test-support'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'

const releases: (() => void)[] = []
afterEach(async () => {
  releases.splice(0).forEach((release) => release())
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

it.each(['claude', 'codex'] as const)(
  'journals a large received %s result before exit despite a busy disk',
  async (agent) => {
    const rig = await openProviderTimelineRig()
    const pressure = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(),
      onBackpressureChange: pressure
    })
    releases.push(() => deferred.close())
    deferred.bind({ journal: rig.journal, fence: 1, publish: () => {} })
    const text = `${'\u0001'.repeat((agent === 'claude' ? 6 : 3) * 1024 * 1024)}MIDDLE:TAIL`
    const claude = fakeClaude(),
      codex = fakeCodex()
    const codexSession = codexAdapter(codex)
    const adapter = agent === 'claude' ? claudeAdapter(claude) : codexSession
    const acquireInput = {
      identity: agent === 'claude' ? claudeIdentity(SESSION) : codexIdentity(SESSION),
      fence: 1,
      spawnToken: 'whole-content',
      events: deferred.sink
    }
    await (agent === 'codex'
      ? acquireReadyCodexForTest(codexSession, acquireInput)
      : adapter.acquire(acquireInput))
    if (agent === 'codex') {
      codex.connections[0].handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: 'turn' }
      })
    }
    await deferred.drained()
    const gate = Promise.withResolvers<void>()
    releases.push(() => gate.resolve())
    const cursor = rig.journal.cursor()
    const snapshot = rig.journal.snapshot()
    const blocked = rig.journal.readInOrder(() => {
      expect(
        deferred.sink.tryAppendItem?.(
          { provider: 'legacy', agent: 'grok', sessionId: SESSION, recordId: 'before' },
          { kind: 'status', text: 'before', tone: 'info' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      ).toEqual({ accepted: true })
      return gate.promise
    })
    expect(rig.journal.cursor()).toEqual(cursor)
    expect(rig.journal.snapshot()).toEqual(snapshot)
    const registration = vi.spyOn(rig.journal, 'appendItem')
    if (agent === 'claude') {
      claudeFrame(claude.connections[0], {
        type: 'user',
        uuid: 'large-result',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'received', content: text }]
        }
      })
      claude.connections[0].handlers.onExit?.(new Error('provider exited'))
    } else {
      codex.connections[0].handlers.onNotification?.('item/completed', {
        threadId: THREAD_ID,
        turnId: 'turn',
        item: {
          type: 'commandExecution',
          id: 'received',
          command: 'run',
          status: 'completed',
          aggregatedOutput: text
        }
      })
      codex.connections[0].handlers.onExit?.(new Error('provider exited'))
    }
    if ('drainObservedExits' in adapter) {
      await adapter.drainObservedExits()
    }
    expect(
      registration.mock.calls.some(
        ([, body]) => body.kind === 'tool-call' && body.output?.head === text
      )
    ).toBe(true)
    expect(deferred.state().queuedBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(text)))
    expect(pressure).toHaveBeenCalledWith(true, expect.objectContaining({ backpressured: true }))
    let landed = false
    const written = deferred.sink.written?.().then((result) => {
      landed = true
      return result
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(rig.journal.cursor()).toEqual(cursor)
    expect(rig.journal.snapshot()).toEqual(snapshot)
    expect(landed).toBe(false)
    gate.resolve()
    await blocked
    expect(await written).toEqual({ ok: true })
    await deferred.drained()
    const reopened = await rig.reopenJournal()
    const replay = reopened.readSince(cursor)
    if (!replay.ok) {
      throw new Error('Expected the held writes to remain replayable')
    }
    expect(replay.rows[0]).toMatchObject({ kind: 'item', body: { kind: 'status', text: 'before' } })
    expect(
      replay.rows.findIndex(
        (row) =>
          row.kind === 'item' && row.body.kind === 'tool-call' && row.body.state === 'completed'
      )
    ).toBeGreaterThan(0)
    expect(
      reopened.snapshot().items.flatMap(({ body }) => (body.kind === 'tool-call' ? [body] : []))
    ).toContainEqual(
      expect.objectContaining({
        callId: 'received',
        state: 'completed',
        output: expect.objectContaining({ head: text, truncated: false })
      })
    )
    expect(deferred.state().queuedBytes).toBe(0)
    expect(pressure).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ backpressured: false })
    )
    deferred.close()
  }
)

it('hands an ACP omitted-field completion to SQLite before root exit with a blocked predecessor', async () => {
  const session = await openAcpAdapterRig()
  const { rig, acquire, child, frame } = session
  await acquire()
  await sendHello(session, 'large')
  await frame('session/prompt')
  const input = { text: `${'i'.repeat(9 * 1024 * 1024)}INPUT:TAIL` }
  const output = `${'o'.repeat(9 * 1024 * 1024)}OUTPUT:TAIL`
  const start = shellCall('prompt:large', 'in_progress')
  child().agent.notify('session/update', { ...start, update: { ...start.update, rawInput: input } })
  child().agent.notify('session/update', {
    ...start,
    update: { ...start.update, sessionUpdate: 'tool_call_update', rawOutput: output }
  })
  await session.settle()
  const gate = Promise.withResolvers<void>()
  releases.push(() => gate.resolve())
  const cursor = rig.journal.cursor()
  const snapshot = rig.journal.snapshot()
  const blocked = rig.journal.readInOrder(() => {
    expect(
      rig.eventSink.tryAppendItem?.(
        { provider: 'legacy', agent: 'grok', sessionId: SESSION, recordId: 'before' },
        { kind: 'status', tone: 'info', text: 'before' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
      )
    ).toEqual({ accepted: true })
    return gate.promise
  })
  expect(rig.journal.cursor()).toEqual(cursor)
  expect(rig.journal.snapshot()).toEqual(snapshot)
  const registration = vi.spyOn(rig.journal, 'appendSteps')
  child().agent.notify('session/update', shellCall('prompt:large', 'completed'))
  await vi.waitFor(() => expect(registration).toHaveBeenCalled())
  child().exit()
  let landed = false
  const written = rig.eventSink.written?.().then((result) => {
    landed = true
    return result
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(rig.journal.cursor()).toEqual(cursor)
  expect(rig.journal.snapshot()).toEqual(snapshot)
  expect(landed).toBe(false)
  gate.resolve()
  await blocked
  expect(await written).toEqual({ ok: true })
  const reopened = await rig.reopenJournal()
  const replay = reopened.readSince(cursor)
  if (!replay.ok) {
    throw new Error('Expected the held writes to remain replayable')
  }
  expect(replay.rows[0]).toMatchObject({ kind: 'item', body: { kind: 'status', text: 'before' } })
  expect(
    replay.rows.findIndex(
      (row) =>
        row.kind === 'item' && row.body.kind === 'tool-call' && row.body.state === 'completed'
    )
  ).toBeGreaterThan(0)
  expect(
    reopened.snapshot().items.flatMap(({ body }) => (body.kind === 'tool-call' ? [body] : []))
  ).toContainEqual(
    expect.objectContaining({
      callId: 'sleep-1',
      state: 'completed',
      input,
      output: expect.objectContaining({ head: output, truncated: false })
    })
  )
})
