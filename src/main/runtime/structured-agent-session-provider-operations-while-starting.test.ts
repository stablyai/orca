// An operation only the agent's protocol session can perform (a rewind, a goal, the recovery of a
// rewind left in doubt) never reaches a child still proving its start, for any agent. Driven through
// the real Codex and ACP adapters with only the provider child scripted.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../shared/agent-session-wire'
import { ACP_LAUNCH_SPECS } from '../acp/acp-launch-specs'
import { acpScriptedChild } from '../acp/acp-scripted-child.test-fixture'
import { acpStructuredAgentDefinition } from '../acp/acp-structured-agent-definitions'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import {
  CODEX_SCRIPTED_THREAD,
  codexScriptedChild
} from '../codex/codex-scripted-child.test-fixture'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { ScriptedAgentChild } from './structured-agent-scripted-child.test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const CALLER = { callerKey: 'provider-operations-test' }
let root: string | undefined
let operations = 0
/** The attach that opened the chat; a reconnecting view replays it. */
let openedWith: Parameters<StructuredAgentSessionHost['attach']>[1] | undefined

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

const eventually = (assertion: () => void | Promise<void>) =>
  vi.waitFor(assertion, { timeout: 10_000 })

function envelope(
  host: StructuredAgentSessionHost,
  method: string,
  fields: Record<string, unknown>
): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function openChat(
  child: ScriptedAgentChild,
  definition: StructuredAgentDefinition = CODEX_STRUCTURED_AGENT
): Promise<StructuredAgentSessionHost> {
  const { agent } = definition
  root = await mkdtemp(join(tmpdir(), `orca-provider-operations-${agent}-`))
  const directory = root
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: directory,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => directory,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    ...child.deps
  })
  const params = hostTestAttachParams(null, {
    provider: agent,
    agent,
    accountHome:
      definition.accountLocatorKind === 'opencode'
        ? { kind: 'opencode', locator: { kind: 'unmanaged' } }
        : { variable: definition.accountHomeVariable, path: join(directory, agent) },
    providerHandle: undefined
  })
  // The runtime admits operation ids against its own clock.
  params.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, params)
  expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
  openedWith = params
  return host
}

async function send(host: StructuredAgentSessionHost, text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, { envelope: envelope(host, 'agentSession.send', { body }), body })
}

/** A first turn the scripted Codex recorded, then the chat put to rest with a turn to target. */
async function codexChatAtRestWithATurn(child: ReturnType<typeof codexScriptedChild>) {
  child.holdHandshakes = false
  const host = await openChat(child)
  child.releaseHandshake()
  const first = await send(host, 'first turn')
  if (!first.ok) {
    throw new Error(JSON.stringify(first.refusal))
  }
  const { clientMessageId } = first.value
  let providerItemId: string | null = null
  await eventually(async () => {
    const submission = (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === clientMessageId
    )
    expect(submission?.providerItemId).toEqual(expect.any(String))
    providerItemId = submission?.providerItemId ?? null
  })
  await host.close(SESSION, 'evict')
  expect(child.closes()).toBe(1)
  child.holdHandshakes = true
  return {
    host,
    itemId: agentJournalSubmissionKey(clientMessageId),
    providerItemId: providerItemId!
  }
}

/** Resolves to whether `pending` settled within a short wait. */
async function settlesSoon(pending: Promise<unknown>): Promise<boolean> {
  let settled = false
  void pending.finally(() => (settled = true))
  await new Promise((resolve) => setTimeout(resolve, 50))
  return settled
}

it('recovers a Codex rewind left in doubt once the restarted thread is open, then delivers the send that started it', async () => {
  const child = codexScriptedChild({
    'thread/read': () => ({ thread: { id: CODEX_SCRIPTED_THREAD, status: { type: 'idle' } } }),
    // The rewound turn is gone and nothing earlier is retained: the provider applied the rewind.
    'thread/turns/list': () => ({ data: [], nextCursor: null }),
    'thread/items/list': () => ({ data: [], nextCursor: null })
  })
  const { host, itemId, providerItemId } = await codexChatAtRestWithATurn(child)
  const { store } = host.deps
  const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
  const request = envelope(host, 'agentSession.rewind', { itemId, expectedEpoch })
  await store.admitMutationOperation({
    callerKey: CALLER.callerKey,
    envelope: request,
    hostFingerprint: request.payloadFingerprint,
    now: Date.now()
  })
  await store.transitionHandoff(SESSION, (record) => ({
    ...record,
    rewind: {
      operationId: request.clientOperationId,
      callerKey: CALLER.callerKey,
      itemId,
      providerItemId,
      expectedEpoch,
      phase: 'prepared',
      retained: []
    }
  }))

  const sent = send(host, 'after the rewind')
  await eventually(() => expect(child.spawns()).toBe(2))
  expect(await settlesSoon(sent)).toBe(false)
  child.releaseHandshake()

  expect(await sent).toMatchObject({ ok: true })
  expect(store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
  await eventually(() => expect(child.prompts()).toEqual(['first turn', 'after the rewind']))
})

it('settles a rewind that goes in doubt while a send waits in the queue, by waiting out the start the send needs', async () => {
  const child = codexScriptedChild({
    'thread/read': () => ({ thread: { id: CODEX_SCRIPTED_THREAD, status: { type: 'idle' } } }),
    'thread/turns/list': () => ({ data: [], nextCursor: null }),
    'thread/items/list': () => ({ data: [], nextCursor: null })
  })
  const { host, itemId, providerItemId } = await codexChatAtRestWithATurn(child)
  const { store } = host.deps
  const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
  const queueHeld = Promise.withResolvers<void>()
  void host.collaboratorsForTests().serialize(SESSION, () => queueHeld.promise)

  // Nothing is in doubt when the send arrives; it waits in the queue.
  const sent = send(host, 'after the rewind')
  expect(await settlesSoon(sent)).toBe(false)
  const request = envelope(host, 'agentSession.rewind', { itemId, expectedEpoch })
  await store.admitMutationOperation({
    callerKey: CALLER.callerKey,
    envelope: request,
    hostFingerprint: request.payloadFingerprint,
    now: Date.now()
  })
  await store.transitionHandoff(SESSION, (record) => ({
    ...record,
    rewind: {
      operationId: request.clientOperationId,
      callerKey: CALLER.callerKey,
      itemId,
      providerItemId,
      expectedEpoch,
      phase: 'prepared',
      retained: []
    }
  }))
  queueHeld.resolve()

  // The send starts the agent to settle the rewind, and waits that start out.
  await eventually(() => expect(child.spawns()).toBe(2))
  expect(await settlesSoon(sent)).toBe(false)
  child.releaseHandshake()

  expect(await sent).toMatchObject({ ok: true })
  expect(store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
  await eventually(() => expect(child.prompts()).toEqual(['first turn', 'after the rewind']))
})

it('answers a rewind asked of a resting Codex chat from the thread it opens, leaving nothing in doubt', async () => {
  const child = codexScriptedChild({
    'thread/resume': (params) => ({
      thread: { id: params?.threadId, historyMode: 'legacy' },
      model: 'scripted-model'
    })
  })
  const { host, itemId } = await codexChatAtRestWithATurn(child)
  const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch

  const rewound = host.rewind(CALLER, {
    itemId,
    expectedEpoch,
    envelope: envelope(host, 'agentSession.rewind', { itemId, expectedEpoch })
  })
  await eventually(() => expect(child.spawns()).toBe(2))
  expect(await settlesSoon(rewound)).toBe(false)
  child.releaseHandshake()

  // Only the opened thread says its history cannot be rewound.
  expect(await rewound).toMatchObject({
    ok: false,
    refusal: { rewindReason: 'history-not-paginated' }
  })
  expect(host.deps.store.getRecord(SESSION)?.rewind).toBeUndefined()
  expect(await send(host, 'still sends')).toMatchObject({ ok: true })
  await eventually(() => expect(child.prompts()).toEqual(['first turn', 'still sends']))
})

it('sets a goal asked of a starting Codex chat on the thread once it is open', async () => {
  const child = codexScriptedChild()
  const host = await openChat(child)
  const change = { kind: 'set' as const, objective: 'Ship the release' }

  const goal = host.changeThreadGoal(CALLER, {
    envelope: envelope(host, 'agentSession.threadGoal', { change }),
    change
  })
  expect(await settlesSoon(goal)).toBe(false)
  child.releaseHandshake()

  expect(await goal).toMatchObject({ ok: true })
  expect(child.requests().filter(({ method }) => method.startsWith('thread/goal'))).toEqual([
    {
      method: 'thread/goal/set',
      params: { threadId: CODEX_SCRIPTED_THREAD, objective: 'Ship the release', status: 'active' }
    }
  ])
})

it('keeps a goal waiting on a starting Codex chat through a re-attach, then sets it once the thread is open', async () => {
  const child = codexScriptedChild()
  const host = await openChat(child)
  const change = { kind: 'set' as const, objective: 'Ship the release' }

  const goal = host.changeThreadGoal(CALLER, {
    envelope: envelope(host, 'agentSession.threadGoal', { change }),
    change
  })
  expect(await settlesSoon(goal)).toBe(false)
  // A view reconnects while the chat is still starting: its replayed attach keeps the live child.
  if (!openedWith) {
    throw new Error('the chat was not opened')
  }
  expect(await host.attach(CALLER, openedWith)).toMatchObject({ ok: true, replayed: true })
  expect(child.spawns()).toBe(1)
  expect(await settlesSoon(goal)).toBe(false)
  child.releaseHandshake()

  expect(await goal).toMatchObject({ ok: true })
  expect(child.requests().some(({ method }) => method === 'thread/goal/set')).toBe(true)
})

it('answers a goal asked of an ACP agent, which has none, without waiting out its start', async () => {
  const spec = ACP_LAUNCH_SPECS[0]!
  const child = acpScriptedChild(spec.agent)()
  const host = await openChat(child, acpStructuredAgentDefinition(spec))
  const change = { kind: 'set' as const, objective: 'Ship the release' }

  const goal = host.changeThreadGoal(CALLER, {
    envelope: envelope(host, 'agentSession.threadGoal', { change }),
    change
  })
  expect(await settlesSoon(goal)).toBe(true)
  expect(await goal).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'goalsUnsupported' } }
  })
  child.releaseHandshake()

  expect(await send(host, 'after the goal')).toMatchObject({ ok: true })
  await eventually(() => expect(child.prompts()).toEqual(['after the goal']))
})
