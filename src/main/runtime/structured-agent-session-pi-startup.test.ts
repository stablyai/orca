import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { structuredAgentSessionResumeParams } from '../native-chat/agent-session-wire/structured-agent-session-resume-eligibility'
import type { OrcaRuntimeService } from './orca-runtime'
import { prepareStructuredAgentSessionCreateForWorktree } from './rpc/methods/structured-agent-session-create'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../shared/structured-agent-session-options'
import {
  structuredAgentSessionShownSnapshot,
  structuredAgentSessionMessageSelection
} from '../../shared/structured-agent-session-option-view'
import { readPiRpcModelOptions } from '../pi/rpc-options'
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
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    directory = undefined
  }
})

async function setup(
  options: {
    native?: Parameters<typeof piScriptedChild>[0]
    seed?: Record<string, string>
    explicit?: Record<string, string>
    catalog?: AgentSessionModelOption[]
    create?: true
    firstMessage?: string
  } = {}
) {
  directory = await mkdtemp(join(tmpdir(), 'orca-pi-startup-'))
  const root = directory
  const script = piScriptedChild(options.native)
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({}),
    ...(options.catalog
      ? {
          resolveAgentAccountHome: async () => ({
            variable: 'PI_CODING_AGENT_DIR' as const,
            path: root
          })
        }
      : {}),
    ...script.deps
  })
  if (options.catalog) {
    vi.spyOn(host.deps.modelCatalog!, 'read').mockResolvedValue({
      origin: 'probe',
      fetchedAt: 1,
      models: options.catalog
    })
  }
  const caller = { callerKey: 'pi-startup-test' }
  const params = hostTestAttachParams(null, {
    ...(options.seed ? { options: options.seed } : {}),
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
  let preparedParams = params
  let catalogModels: readonly AgentSessionModelOption[] | undefined
  if (options.create) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preparation reaches only these runtime resolvers; host/capture/adapter are real.
    const runtime = {
      resolveStructuredAgentSessionCreateIntent: async () => params,
      resolveStructuredAgentSessionLocalWorkspacePath: async () => root
    } as unknown as OrcaRuntimeService
    const prepared = await prepareStructuredAgentSessionCreateForWorktree({
      runtime,
      ensureHost: async () => host,
      envelope: params.envelope,
      worktree: 'id:folder-1',
      agent: 'pi',
      caller,
      options: options.explicit,
      atRest: true
    })
    preparedParams = prepared.attachParams
    catalogModels = prepared.catalogModels
  }
  const attached = options.create
    ? await host.create(caller, preparedParams, {
        catalogModels,
        ...(options.firstMessage
          ? {
              firstMessage: {
                clientMessageId: operationId(),
                body: hostTestMessage(options.firstMessage)
              }
            }
          : {})
      })
    : await host.attach(caller, params)
  expect(attached.ok).toBe(true)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  return { script, host, caller, params: preparedParams, fence: attached.value.fence }
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
  expect(stateInputs(script)).toMatchObject([
    { command: 'set_model', params: { provider: 'scripted', modelId: 'model-2' } },
    { command: 'set_thinking_level', params: { level: 'low' } },
    { command: 'prompt', params: { message: 'first message', effort: 'low' } }
  ])
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

const gpt5 = {
  provider: 'openai-codex',
  id: 'gpt-6.1-sol',
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max'
  }
}
const stateInputs = (script: ReturnType<typeof piScriptedChild>) =>
  script.inputs().filter(({ command }) => command.startsWith('set_') || command === 'prompt')
const sendText = (
  host: Awaited<ReturnType<typeof setup>>['host'],
  caller: { callerKey: string },
  text: string,
  selection?: Readonly<Record<string, string>>
) => {
  const body = hostTestMessage(text)
  const fields = { body, ...(selection !== undefined ? { selection } : {}) }
  return host.send(caller, { envelope: envelope('agentSession.send', fields), ...fields })
}

function displayed(
  answer: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['host']['readOptions']>>
) {
  const seed = structuredAgentSessionSeedCatalog('pi')
  return structuredAgentSessionShownSnapshot(
    applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('pi', seed),
      seed,
      answer
    )
  ).find((entry) => entry.id === 'effort')
}

it('keeps remembered and explicit raw off through create while native application is minimal', async () => {
  const models = await readPiRpcModelOptions({ request: async () => ({ models: [gpt5] }) })
  const h = await setup({
    create: true,
    seed: { model: 'openai-codex/gpt-6.1-sol', effort: 'off' },
    catalog: models,
    native: { model: gpt5, appliedEfforts: { off: 'minimal' } },
    firstMessage: 'new seed'
  })
  expect(h.params.options).toEqual({ model: 'openai-codex/gpt-6.1-sol', effort: 'off' })
  expect(displayed(await h.host.readOptions(HOST_TEST_SESSION))).toMatchObject({
    kind: { currentValue: 'minimal', choices: models[0]!.efforts }
  })
  expect(models[0]!.efforts.map(({ value }) => value)).toEqual([
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ])
  await vi.waitFor(() => expect(h.script.spawns()).toBe(1))
  h.script.releaseHandshake()
  await vi.waitFor(() => expect(h.script.prompts()).toEqual(['new seed']))
  expect(stateInputs(h.script)).toMatchObject([
    { command: 'set_model', params: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' } },
    { command: 'set_thinking_level', params: { level: 'off' } },
    { command: 'prompt', params: { message: 'new seed', effort: 'minimal' } }
  ])
  const explicit = {
    ...h.params,
    options: { model: 'openai-codex/gpt-6.1-sol', effort: 'off' },
    envelope: { ...h.params.envelope, sessionId: 'explicit-off', clientOperationId: operationId() }
  }
  expect(await h.host.create(h.caller, explicit, { catalogModels: models })).toMatchObject({
    ok: true
  })
})

it('restores blank raw intent through start/capture and preserves an accepted high until its next dispatch', async () => {
  // Home discovery and a workspace extension may disagree; live support owns live projection.
  const models = await readPiRpcModelOptions({ request: async () => ({ models: [gpt5] }) })
  const h = await setup({
    create: true,
    seed: { model: 'openai-codex/gpt-6.1-sol', effort: 'minimal' },
    catalog: models,
    native: { model: gpt5, appliedEfforts: { off: 'minimal' } }
  })
  const store = peekOpenedAgentSessionRecordStore()!
  await store.replaceSessionOptions({
    sessionId: HOST_TEST_SESSION,
    fence: h.fence,
    options: { model: 'openai-codex/gpt-6.1-sol', effort: 'off' },
    now: HOST_TEST_NOW
  })
  const resting = await h.host.readOptions(HOST_TEST_SESSION)
  expect(resting.current.effort).toBe('off')
  expect(displayed(resting)).toMatchObject({ kind: { currentValue: 'minimal' } })
  expect(store.getRecord(HOST_TEST_SESSION)?.options?.effort).toBe('off')
  const resume = structuredAgentSessionResumeParams(
    store.getRecord(HOST_TEST_SESSION)!,
    operationId()
  )
  expect(resume).not.toBeNull()
  const started = await h.host.attach(h.caller, resume!)
  expect(started).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(h.script.spawns()).toBe(1))
  h.script.releaseHandshake()
  await vi.waitFor(() => expect(h.script.wire()).toContain('get_commands'))
  expect((await sendText(h.host, h.caller, 'restored blank')).ok).toBe(true)
  await vi.waitFor(() => expect(h.script.prompts()).toEqual(['restored blank']))
  expect(stateInputs(h.script)).toMatchObject([
    { command: 'set_model', params: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' } },
    { command: 'set_thinking_level', params: { level: 'off' } },
    { command: 'prompt', params: { message: 'restored blank', effort: 'minimal' } }
  ])
  vi.mocked(h.host.deps.modelCatalog!.read).mockResolvedValue({
    origin: 'probe',
    fetchedAt: 2,
    models: [{ ...models[0]!, efforts: [{ value: 'off', label: 'Off' }] }]
  })
  await vi.waitFor(async () =>
    expect((await h.host.readOptions(HOST_TEST_SESSION)).current).toMatchObject({
      effort: 'off',
      reportedEffort: 'minimal'
    })
  )
  const capture = (answer: Awaited<ReturnType<typeof h.host.readOptions>>) => {
    const seed = structuredAgentSessionSeedCatalog('pi')
    return structuredAgentSessionMessageSelection(
      applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState('pi', seed),
        seed,
        answer
      )
    )
  }
  h.script.setNativeEffort('low')
  expect(
    (
      await sendText(
        h.host,
        h.caller,
        'same raw off',
        capture(await h.host.readOptions(HOST_TEST_SESSION))
      )
    ).ok
  ).toBe(true)
  await vi.waitFor(async () =>
    expect((await h.host.readOptions(HOST_TEST_SESSION)).current).toMatchObject({
      effort: 'off',
      reportedEffort: 'low'
    })
  )
  expect(stateInputs(h.script).at(-1)).toMatchObject({
    command: 'prompt',
    params: { effort: 'low' }
  })
  expect(
    stateInputs(h.script).filter(({ command }) => command === 'set_thinking_level')
  ).toHaveLength(1)
  const actual = await h.host.readOptions(HOST_TEST_SESSION)
  const seed = structuredAgentSessionSeedCatalog('pi')
  const actualState = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('pi', seed),
    seed,
    actual
  )
  const exact = structuredAgentSessionMessageSelection(actualState)
  expect(exact.effort).toBe('off')
  expect((await sendText(h.host, h.caller, 'captured extension', exact)).ok).toBe(true)
  await vi.waitFor(() => expect(h.script.prompts()).toHaveLength(3))
  expect(stateInputs(h.script).at(-1)).toMatchObject({
    command: 'prompt',
    params: { effort: 'low' }
  })
  expect(
    stateInputs(h.script).filter(({ command }) => command === 'set_thinking_level')
  ).toHaveLength(1)
  const late = applyStructuredAgentSessionModelCatalog(
    actualState,
    seed,
    {
      origin: 'probe',
      fetchedAt: 3,
      models: [{ ...models[0]!, efforts: [{ value: 'minimal', label: 'Minimal' }] }]
    },
    { newLaunch: false, coherentCatalog: true }
  )
  expect(
    structuredAgentSessionShownSnapshot(late).find((entry) => entry.id === 'effort')
  ).toMatchObject({ kind: { currentValue: 'low' } })
  expect(store.getRecord(HOST_TEST_SESSION)?.options?.effort).toBe('off')
  expect(
    (
      await h.host.setOption(h.caller, {
        envelope: envelope('agentSession.setOption', { key: 'effort', value: 'high' }),
        key: 'effort',
        value: 'high'
      })
    ).ok
  ).toBe(true)
  const future = await h.host.readOptions(HOST_TEST_SESSION)
  expect(future.current.effort).toBe('high')
  expect(displayed(future)).toMatchObject({ kind: { currentValue: 'high' } })
  expect(future.current.confirmed).not.toContain('effort')
  expect((await sendText(h.host, h.caller, 'accepted high')).ok).toBe(true)
  await vi.waitFor(() => expect(h.script.prompts()).toHaveLength(4))
  expect(stateInputs(h.script).slice(-2)).toMatchObject([
    { command: 'set_thinking_level', params: { level: 'high' } },
    { command: 'prompt', params: { effort: 'high' } }
  ])
  expect(
    (
      await h.host.setOption(h.caller, {
        envelope: envelope('agentSession.setOption', { key: 'effort', value: 'minimal' }),
        key: 'effort',
        value: 'minimal'
      })
    ).ok
  ).toBe(true)
  const minimal = capture(await h.host.readOptions(HOST_TEST_SESSION))
  expect(minimal.effort).toBe('minimal')
  expect((await sendText(h.host, h.caller, 'raw minimal', minimal)).ok).toBe(true)
  await vi.waitFor(async () =>
    expect((await h.host.readOptions(HOST_TEST_SESSION)).current).toMatchObject({
      effort: 'minimal',
      reportedEffort: 'minimal'
    })
  )
  expect(stateInputs(h.script).slice(-2)).toMatchObject([
    { command: 'set_thinking_level', params: { level: 'minimal' } },
    { command: 'prompt', params: { effort: 'minimal' } }
  ])
  const journal = await h.host.journalSnapshot(HOST_TEST_SESSION)
  expect(journal.submissions.map(({ options }) => options?.effort)).toEqual([
    'off',
    'off',
    'off',
    'high',
    'minimal'
  ])
})

it('displays native gapped support and dispatches raw medium for seed and existing-record input', async () => {
  const model = { ...gpt5, thinkingLevelMap: { medium: null, high: null, xhigh: 'xhigh' } }
  const models = await readPiRpcModelOptions({ request: async () => ({ models: [model] }) })
  const h = await setup({
    create: true,
    seed: { model: 'openai-codex/gpt-6.1-sol', effort: 'medium' },
    catalog: models,
    native: { model, appliedEfforts: { medium: 'xhigh' } },
    firstMessage: 'raw seed'
  })
  expect(h.params.options?.effort).toBe('medium')
  expect(displayed(await h.host.readOptions(HOST_TEST_SESSION))).toMatchObject({
    kind: { currentValue: 'xhigh' }
  })
  await vi.waitFor(() => expect(h.script.spawns()).toBe(1))
  h.script.releaseHandshake()
  await vi.waitFor(() => expect(h.script.prompts()).toHaveLength(1))
  expect(stateInputs(h.script)).toMatchObject([
    { command: 'set_model', params: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' } },
    { command: 'set_thinking_level', params: { level: 'medium' } },
    { command: 'prompt', params: { effort: 'xhigh' } }
  ])
  const store = peekOpenedAgentSessionRecordStore()!
  await store.replaceSessionOptions({
    sessionId: HOST_TEST_SESSION,
    fence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
    options: { model: 'openai-codex/gpt-6.1-sol', effort: 'medium' },
    now: HOST_TEST_NOW
  })
  expect(displayed(await h.host.readOptions(HOST_TEST_SESSION))).toMatchObject({
    kind: { currentValue: 'xhigh' }
  })
  expect((await sendText(h.host, h.caller, 'opaque medium')).ok).toBe(true)
  await vi.waitFor(() => expect(h.script.prompts()).toHaveLength(2))
  expect(stateInputs(h.script).at(-1)).toMatchObject({
    command: 'prompt',
    params: { effort: 'xhigh' }
  })
  expect(
    stateInputs(h.script).filter(({ command }) => command === 'set_thinking_level')
  ).toHaveLength(1)
})
