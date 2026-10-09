import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexScriptedChild } from '../codex/codex-scripted-child.test-fixture'
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
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
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
  for (const [key, value] of [
    ['model', 'scripted-alt-model'],
    ['effort', 'high']
  ] as const) {
    const fields = { key, value }
    expect(
      await host.setOption(caller, {
        envelope: envelope('agentSession.setOption', fence, fields),
        ...fields
      })
    ).toMatchObject({ ok: true })
  }
  const body = hostTestMessage('first message')
  expect(
    (await host.send(caller, { envelope: envelope('agentSession.send', fence, { body }), body })).ok
  ).toBe(true)
  child.releaseHandshake()

  await vi.waitFor(() => expect(child.prompts()).toEqual(['first message']))
  const turn = child.requests().find(({ method }) => method === 'turn/start')
  expect(turn?.params).toMatchObject({ model: 'scripted-alt-model', effort: 'high' })
  expect(host.deps.store.getRecord(HOST_TEST_SESSION)?.options).toMatchObject({
    model: 'scripted-alt-model',
    effort: 'high'
  })
})
