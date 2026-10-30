import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { piScriptedChild } from '../pi/pi-scripted-child.test-fixture'
import { peekOpenedAgentSessionRecordStore } from './agent-session-record-store-slot'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

let directory: string | undefined
let operations = 0
const operationId = () => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

async function setup() {
  directory = await mkdtemp(join(tmpdir(), 'orca-pi-startup-'))
  const root = directory
  const script = piScriptedChild()
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({}),
    ...script.deps
  })
  const caller = { callerKey: 'pi-startup-test' }
  const params = hostTestAttachParams(null, {
    provider: 'pi',
    agent: 'pi',
    providerHandle: undefined,
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: root },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    }
  })
  params.envelope.clientOperationId = operationId()
  const attached = await host.attach(caller, params)
  expect(attached.ok).toBe(true)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  return { script, host, caller, fence: attached.value.fence }
}

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: HOST_TEST_SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence:
      peekOpenedAgentSessionRecordStore()?.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: HOST_TEST_SESSION,
      fields
    })
  }
}

it('attaches Pi at spawn and holds the opening send until the provider answers its handshake', async () => {
  const { script, host, caller, fence } = await setup()
  expect(script.spawns()).toBe(1)
  const body = hostTestMessage('hello while Pi is starting')
  const sent = await host.send(caller, {
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: HOST_TEST_SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent.ok).toBe(true)
  expect(script.prompts()).toEqual([])
  script.releaseHandshake()
  await vi.waitFor(() => expect(script.prompts()).toEqual(['hello while Pi is starting']))
  await vi.waitFor(() =>
    expect(peekOpenedAgentSessionRecordStore()?.getRecord(HOST_TEST_SESSION)?.options).toEqual({
      model: 'scripted/model-1'
    })
  )
  await expect(host.readOptions(HOST_TEST_SESSION)).resolves.toMatchObject({
    current: { model: 'scripted/model-1', effort: 'medium' }
  })
  expect(script.wire()).not.toContain('set_thinking_level')
  await stopStructuredAgentSessionRuntime()
  expect(script.closes()).toBe(1)
})

it('writes startup model and effort picks before a message accepted after them', async () => {
  const { script, host, caller } = await setup()
  const picked = (
    [
      ['model', 'scripted/model-2'],
      ['effort', 'low']
    ] as const
  ).map(([key, value]) =>
    host.setOption(caller, {
      envelope: envelope('agentSession.setOption', { key, value }),
      key,
      value
    })
  )
  const body = hostTestMessage('first message')
  const sent = host.send(caller, { envelope: envelope('agentSession.send', { body }), body })
  expect(script.wire()).not.toContain('set_model')
  script.releaseHandshake()
  expect((await Promise.all(picked)).every((result) => result.ok)).toBe(true)
  expect((await sent).ok).toBe(true)
  await vi.waitFor(() => expect(script.prompts()).toEqual(['first message']))
  const wire = script.wire()
  expect(wire.indexOf('set_model')).toBeGreaterThanOrEqual(0)
  expect(wire.indexOf('set_thinking_level')).toBeGreaterThan(wire.indexOf('set_model'))
  expect(wire.indexOf('prompt:first message')).toBeGreaterThan(wire.indexOf('set_thinking_level'))
  expect(peekOpenedAgentSessionRecordStore()?.getRecord(HOST_TEST_SESSION)?.options).toMatchObject({
    model: 'scripted/model-2',
    effort: 'low'
  })
})

it('ends Pi on Stop and resumes its real session file when the next send starts a child', async () => {
  const { script, host, caller } = await setup()
  script.completeTurns = false
  script.releaseHandshake()
  const first = hostTestMessage('start a long turn')
  expect(
    (
      await host.send(caller, {
        envelope: envelope('agentSession.send', { body: first }),
        body: first
      })
    ).ok
  ).toBe(true)
  await vi.waitFor(() => expect(script.prompts()).toEqual(['start a long turn']))
  expect((await host.cancel(caller, { envelope: envelope('agentSession.cancel', {}) })).ok).toBe(
    true
  )
  await vi.waitFor(() => expect(script.closes()).toBe(1))
  const second = hostTestMessage('resume after Stop')
  expect(
    (
      await host.send(caller, {
        envelope: envelope('agentSession.send', { body: second }),
        body: second
      })
    ).ok
  ).toBe(true)
  await vi.waitFor(() => expect(script.spawns()).toBe(2))
  expect(script.resumes()).toBe(1)
  expect(script.prompts()).toEqual(['start a long turn'])
  script.releaseHandshake()
  await vi.waitFor(() =>
    expect(script.prompts()).toEqual(['start a long turn', 'resume after Stop'])
  )
})
