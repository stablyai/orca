import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexScriptedChild } from '../codex/codex-scripted-child.test-fixture'
import { createCodexAppServerRecordDispatcher } from '../codex/codex-app-server-record-dispatch'
import { readCodexThreadId, readCodexTurnId } from '../codex/codex-structured-thread-facts'
import * as turnOptions from '../native-chat/agent-session-wire/structured-agent-session-message-options'
import { createStructuredMailboxPointerHost } from './orchestration/structured-mailbox-pointer-host'
import { structuredMailSource } from './orchestration/structured-mail-source'
import { scriptedCodexTransport } from './scripted-codex-transport.test-fixture'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { ScriptedAgentChild } from './structured-agent-scripted-child.test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

let root: string | undefined
const caller = { callerKey: 'scripted-codex-test' }
let operation = 0

function envelope(method: string, fence: number, fields: Record<string, unknown>) {
  return {
    sessionId: HOST_TEST_SESSION,
    clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: HOST_TEST_SESSION,
      fields
    })
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('delivers current-choice mail during a recorded Codex turn while changed-choice input waits for completion', async () => {
  // Recorded real-binary lifecycle, with a faked upstream provider; original null clientIds stay intact.
  const frames: { case: string; method: string; params: Record<string, unknown> }[] = readFileSync(
    join(__dirname, '../codex/__fixtures__/codex-app-server-turn-endings.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.case === '0.158.0-control')
  const threadId = readCodexThreadId(frames[0]?.params)!
  const turnId = readCodexTurnId(frames.find(({ method }) => method === 'turn/started')?.params)!
  const oldChoices = { model: 'scripted-model', effort: 'low' }
  const capture = { model: 'scripted-alt-model', effort: 'high' }
  let starts = 0
  const child = codexScriptedChild({
    'thread/start': () => ({ thread: { id: threadId }, model: oldChoices.model }),
    'turn/start': () => ({ turn: { id: ++starts === 1 ? turnId : 'scripted-next-turn' } }),
    'turn/steer': () => ({ turnId }),
    'model/list': () => ({
      data: [
        {
          model: oldChoices.model,
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
        },
        { model: capture.model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }
      ],
      nextCursor: null
    })
  })
  child.holdHandshakes = false
  const open = child.deps.openCodexConnection!
  let dispatcher: ReturnType<typeof createCodexAppServerRecordDispatcher> | undefined
  const { host, fence } = await attachedHost({
    ...child,
    deps: {
      ...child.deps,
      ...scriptedCodexTransport(async (launch, handlers = {}) => {
        dispatcher = createCodexAppServerRecordDispatcher({
          handlers,
          writeResponse: () => {},
          onProtocolFailure: (error) => {
            throw error
          }
        })
        return open(launch, handlers)
      })
    }
  })
  const dispatch = vi.spyOn(host.deps.adapter, 'dispatch')
  const waits = vi.spyOn(turnOptions, 'waitsForCodexTurnOptions')
  const requests = () =>
    child.requests().filter(({ method }) => method === 'turn/start' || method === 'turn/steer')
  const a = hostTestMessage('A on current choices')
  const aEnvelope = envelope('agentSession.send', fence, { body: a, options: oldChoices })
  expect(
    await host.send(caller, { envelope: aEnvelope, body: a, options: oldChoices })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  expect(requests()[0]).toMatchObject({ method: 'turn/start', params: oldChoices })
  const idleAt = frames.findIndex(
    ({ method, params }) =>
      method === 'thread/status/changed' && JSON.stringify(params.status) === '{"type":"idle"}'
  )
  for (const frame of frames.slice(0, 4)) {
    dispatcher!.dispatch({ method: frame.method, params: frame.params })
  }
  // SCRIPTED correlation only: these are not recorded mail/user echoes or rewritten capture frames.
  const echo = (clientId: string, rootTurnId = turnId) =>
    dispatcher!.dispatch({
      method: 'item/completed',
      params: {
        threadId,
        turn: { id: rootTurnId },
        item: { type: 'userMessage', id: `scripted-echo-${clientId}`, clientId, content: [] }
      }
    })
  echo(aEnvelope.clientOperationId)
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  expect(host.currentWork(HOST_TEST_SESSION)?.activeTurnId()).toBe(turnId)
  for (const [key, value] of Object.entries(capture)) {
    expect(
      await host.setOption(caller, {
        envelope: envelope('agentSession.setOption', fence, { key, value }),
        key,
        value
      })
    ).toMatchObject({ ok: true })
  }
  const mail = {
    ...hostTestMessage('worker mail on current choices'),
    from: structuredMailSource({
      db: null,
      mailboxHandle: 'dispatch:recorded-contract',
      dispatchId: 'recorded-contract',
      batch: [],
      senderName: () => null
    })
  }
  const mailId = envelope('mail', fence, {}).clientOperationId
  const sentMail = createStructuredMailboxPointerHost().send({
    sessionId: HOST_TEST_SESSION,
    dispatchId: 'recorded-contract',
    operationId: mailId,
    expectedRuntimeFence: fence,
    body: mail,
    holdWhileWorking: false
  })
  await vi.waitFor(() => expect(requests()).toHaveLength(2))
  expect(requests()[1]).toMatchObject({
    method: 'turn/steer',
    params: {
      expectedTurnId: turnId,
      clientUserMessageId: mailId,
      input: [{ type: 'text', text: 'worker mail on current choices' }]
    }
  })
  expect(requests()[1]?.params).not.toHaveProperty('model')
  expect(requests()[1]?.params).not.toHaveProperty('effort')
  const mailDispatch = dispatch.mock.calls.find(([input]) => input.clientMessageId === mailId)![0]
  expect(mailDispatch.executionOptions).toBeUndefined()
  expect(
    waits.mock.calls.some(
      ([, , next], index) =>
        next.clientMessageId === mailId &&
        next.options === undefined &&
        waits.mock.results[index]?.value === false
    )
  ).toBe(true)
  echo(mailId)
  expect(await sentMail).toEqual({ kind: 'sent', state: 'accepted' })
  const b = hostTestMessage('ordinary B with captured choices')
  const bEnvelope = envelope('agentSession.send', fence, { body: b, options: capture })
  const bId = bEnvelope.clientOperationId
  expect(await host.send(caller, { envelope: bEnvelope, body: b, options: capture })).toMatchObject(
    { ok: true }
  )
  await vi.waitFor(() =>
    expect(
      waits.mock.calls.some(
        ([, , next], index) =>
          next.clientMessageId === bId && waits.mock.results[index]?.value === true
      )
    ).toBe(true)
  )
  for (const frame of frames.slice(4, idleAt + 1)) {
    dispatcher!.dispatch({ method: frame.method, params: frame.params })
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  expect(host.currentWork(HOST_TEST_SESSION)?.activeTurnId()).toBe(turnId)
  expect(requests()).toHaveLength(2)
  for (const frame of frames.slice(idleAt + 1)) {
    dispatcher!.dispatch({ method: frame.method, params: frame.params })
  }
  await vi.waitFor(() => expect(requests()).toHaveLength(3))
  expect(requests()[2]).toMatchObject({
    method: 'turn/start',
    params: {
      ...capture,
      clientUserMessageId: bId,
      input: [{ type: 'text', text: 'ordinary B with captured choices' }]
    }
  })
  expect(dispatch.mock.calls.filter(([input]) => input.clientMessageId === bId)).toHaveLength(1)
  expect(
    dispatch.mock.calls.find(([input]) => input.clientMessageId === bId)![0].executionOptions
  ).toEqual(capture)
  echo(bId, 'scripted-next-turn')
  await vi.waitFor(async () => {
    const { submissions } = await host.journalSnapshot(HOST_TEST_SESSION)
    expect(submissions.find(({ clientMessageId }) => clientMessageId === bId)).toMatchObject({
      options: capture,
      dispatchState: 'accepted'
    })
    expect(submissions.find(({ clientMessageId }) => clientMessageId === mailId)).toMatchObject({
      dispatchState: 'accepted'
    })
    expect(
      submissions.find(({ clientMessageId }) => clientMessageId === mailId)?.options
    ).toBeUndefined()
  })
  expect(child.spawns()).toBe(1)
  expect(child.closes()).toBe(0)
})

async function attachedHost(child: ScriptedAgentChild) {
  root = await mkdtemp(join(tmpdir(), 'orca-scripted-codex-'))
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root ?? '',
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    ...child.deps
  })
  const attach = hostTestAttachParams(null, { providerHandle: undefined })
  attach.envelope.clientOperationId = `${Date.now()}-${'b'.repeat(32)}`
  const attached = await host.attach(caller, attach)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  return { host, fence: attached.value.fence }
}

it('attaches at spawn and holds sends until the scripted Codex handshake answers', async () => {
  const child = codexScriptedChild()
  const { host, fence } = await attachedHost(child)
  const body = hostTestMessage('held until Codex is ready')
  const sent = await host.send(caller, {
    envelope: envelope('agentSession.send', fence, { body }),
    body
  })
  expect(sent.ok).toBe(true)
  expect(child.spawns()).toBe(1)
  expect(host.deps.store.getRecord(HOST_TEST_SESSION)?.lease.ownerProcess).toMatchObject({
    pid: expect.any(Number),
    spawnToken: expect.any(String)
  })
  expect(child.prompts()).toEqual([])
  child.releaseHandshake()
  await vi.waitFor(() => expect(child.prompts()).toEqual(['held until Codex is ready']))
})

it('ends a running Codex child on Stop and resumes its thread for the next send', async () => {
  const child = codexScriptedChild()
  child.holdHandshakes = false
  child.completeTurns = false
  const { host, fence } = await attachedHost(child)
  const body = hostTestMessage('first turn')
  expect(
    (await host.send(caller, { envelope: envelope('agentSession.send', fence, { body }), body })).ok
  ).toBe(true)
  await vi.waitFor(() => expect(child.prompts()).toEqual(['first turn']))
  expect(
    (await host.cancel(caller, { envelope: envelope('agentSession.cancel', fence, {}) })).ok
  ).toBe(true)
  await host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {})
  expect(child.closes()).toBe(1)
  const next = hostTestMessage('next turn')
  expect(
    (
      await host.send(caller, {
        envelope: envelope('agentSession.send', fence, { body: next }),
        body: next
      })
    ).ok
  ).toBe(true)
  await vi.waitFor(() => expect(child.prompts()).toEqual(['first turn', 'next turn']))
  expect(child.spawns()).toBe(2)
  expect(child.resumes()).toBe(1)
})

it('can Stop the scripted child during initialization and settle a held send as withdrawn', async () => {
  const child = codexScriptedChild()
  const { host, fence } = await attachedHost(child)
  const body = hostTestMessage('never handed over')
  const sent = await host.send(caller, {
    envelope: envelope('agentSession.send', fence, { body }),
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  expect(
    (await host.cancel(caller, { envelope: envelope('agentSession.cancel', fence, {}) })).ok
  ).toBe(true)
  await host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {})
  expect(child.closes()).toBe(1)
  expect(child.prompts()).toEqual([])
  const { submissions } = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(
    submissions.find((entry) => entry.clientMessageId === sent.value.clientMessageId)?.dispatchState
  ).toBe('rejected')
})

it('hands Codex a model and effort picked while it started before the first message', async () => {
  const child = codexScriptedChild()
  const { host, fence } = await attachedHost(child)
  const picks = (
    [
      ['model', 'scripted-alt-model'],
      ['effort', 'high']
    ] as const
  ).map(([key, value]) => {
    const fields = { key, value }
    return host.setOption(caller, {
      envelope: envelope('agentSession.setOption', fence, fields),
      ...fields
    })
  })
  const body = hostTestMessage('first message')
  const sent = host.send(caller, { envelope: envelope('agentSession.send', fence, { body }), body })
  child.releaseHandshake()
  expect(await Promise.all(picks)).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true })
  ])
  expect((await sent).ok).toBe(true)

  await vi.waitFor(() => expect(child.prompts()).toEqual(['first message']))
  const turn = child.requests().find(({ method }) => method === 'turn/start')
  expect(turn?.params).toMatchObject({ model: 'scripted-alt-model', effort: 'high' })
  expect(host.deps.store.getRecord(HOST_TEST_SESSION)?.options).toMatchObject({
    model: 'scripted-alt-model',
    effort: 'high'
  })
})

it('rejects a held send once when Codex initialization refuses and closes the child once', async () => {
  const child = codexScriptedChild()
  const { host, fence } = await attachedHost(child)
  const body = hostTestMessage('never delivered')
  const sent = await host.send(caller, {
    envelope: envelope('agentSession.send', fence, { body }),
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  await vi.waitFor(() =>
    expect(child.requests().some((request) => request.method === 'initialize')).toBe(true)
  )
  child.failHandshake('Please sign in to Codex')
  await vi.waitFor(async () => {
    const { submissions } = await host.journalSnapshot(HOST_TEST_SESSION)
    const rejected = submissions.filter(
      (entry) => entry.clientMessageId === sent.value.clientMessageId
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.dispatchState).toBe('rejected')
  })
  expect(child.closes()).toBe(1)
  expect(child.spawns()).toBe(1)
  expect(child.prompts()).toEqual([])
})

it('stops while thread/start is held and never hands over the accepted send', async () => {
  const thread = Promise.withResolvers<unknown>()
  const child = codexScriptedChild({ 'thread/start': () => thread.promise })
  child.holdHandshakes = false
  const { host, fence } = await attachedHost(child)
  const body = hostTestMessage('never delivered')
  const sent = await host.send(caller, {
    envelope: envelope('agentSession.send', fence, { body }),
    body
  })
  expect(sent.ok).toBe(true)
  await vi.waitFor(() =>
    expect(child.requests().some((request) => request.method === 'thread/start')).toBe(true)
  )
  expect(
    (await host.cancel(caller, { envelope: envelope('agentSession.cancel', fence, {}) })).ok
  ).toBe(true)
  thread.resolve({ thread: { id: 'scripted-codex-thread' } })
  await host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {})
  expect(child.closes()).toBe(1)
  expect(child.prompts()).toEqual([])
})
