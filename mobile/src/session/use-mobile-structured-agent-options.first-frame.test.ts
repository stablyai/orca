import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/agent-session/structured-agent-session-reducer'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { deferred } from './use-mobile-structured-agent-options.test-fixture'

const HOST_LIST: AgentSessionModelCatalogResult = {
  origin: 'probe',
  models: [{ id: 'gpt-host', label: 'GPT Host', isDefault: true, efforts: [] }],
  fetchedAt: 1_000
}

function client(
  catalog: () => Promise<AgentSessionModelCatalogResult>,
  options?: () => Promise<AgentSessionOptionsResult>
): RpcClient {
  return {
    sendRequest: async (method: string) =>
      method === 'agentSession.modelCatalog'
        ? { id: 'rpc-1', ok: true as const, result: await catalog(), _meta: { runtimeId: 'r' } }
        : method === 'agentSession.options' && options
          ? { id: 'rpc-2', ok: true as const, result: await options(), _meta: { runtimeId: 'r' } }
          : new Promise(() => {}),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

function modelChoices(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const model = snapshot.find((entry) => entry.id === 'model')
  return model?.kind.type === 'select' ? model.kind.choices.map((choice) => choice.value) : []
}

type Props = { rpc: RpcClient; fence: number | null; agent?: string; enabled?: boolean }

async function mount(initial: Props) {
  const frames: string[][] = []
  const effortFrames: (boolean | undefined)[] = []
  let snapshot: readonly SessionOptionDescriptor[] = []
  const onSendError = vi.fn()
  let latest!: ReturnType<typeof useMobileStructuredAgentOptions>
  function Probe(props: Props): null {
    const mutate = useMobileStructuredAgentMutate({
      client: props.rpc,
      sessionId: 'session-1',
      enabled: props.enabled ?? true,
      stateRef: { current: { ...EMPTY_STRUCTURED_AGENT_SESSION, fence: props.fence } },
      onSendError
    })
    const options = useMobileStructuredAgentOptions({
      agent: props.agent ?? 'codex',
      client: props.rpc,
      sessionId: 'session-1',
      enabled: props.enabled ?? true,
      fence: props.fence,
      mutate,
      turnId: null,
      hostSupport: {
        sendOptions: false,
        permissionModes: true,
        coherentModelCatalog: true,
        statusFeed: false
      }
    })
    latest = options
    frames.push(modelChoices(options.optionSnapshot))
    effortFrames.push(options.optionSnapshot.find((row) => row.id === 'effort')?.settable)
    snapshot = options.optionSnapshot
    return null
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Probe, initial))
  })
  return {
    frames,
    effortFrames,
    snapshot: () => snapshot,
    options: () => latest,
    onSendError,
    update: (next: Props) =>
      act(async () => {
        renderer?.update(createElement(Probe, next))
      }),
    unmount: () => act(async () => renderer?.unmount())
  }
}

describe('the phone picker’s first frame', () => {
  it('shows catalog choices but takes picks only after the runtime fence arrives', async () => {
    const models = (HOST_LIST.models ?? []).map((model) => ({
      ...model,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    }))
    const rpc = client(
      async () => ({ ...HOST_LIST, models }),
      async () => ({
        models,
        listedModelIds: models.map((model) => model.id),
        current: { model: 'gpt-host', effort: 'high', permissionMode: 'ask' }
      })
    )
    const pick = deferred<void>()
    const send = rpc.sendRequest
    rpc.sendRequest = vi.fn(async (method, params, config) => {
      if (method === 'agentSession.setOption') {
        await pick.promise
        return {
          id: 'pick',
          ok: true,
          result: { ok: true, value: { options: { model: 'gpt-host' } } },
          _meta: { runtimeId: 'r' }
        }
      }
      return send(method, params, config)
    })
    const harness = await mount({ rpc, fence: null })
    const locked = (snapshot: readonly SessionOptionDescriptor[]) => {
      expect(snapshot.length).toBeGreaterThan(0)
      for (const row of snapshot) {
        expect(row).toMatchObject({
          settable: false,
          disabledReason: 'available-after-session-start'
        })
      }
    }
    try {
      expect(modelChoices(harness.snapshot())).toEqual(['gpt-host'])
      const requestsBeforePicks = vi.mocked(rpc.sendRequest).mock.calls.length
      await act(async () => {
        for (const [id, value] of [
          ['model', 'gpt-host'],
          ['effort', 'high'],
          ['permissionMode', 'full-access']
        ] as const) {
          expect(await harness.options().setStructuredOption(id, value)).toBe(false)
          locked((await harness.options().optionSurface.setOption(id, value)).snapshot)
        }
      })
      locked(harness.snapshot())
      locked(harness.options().optionSurface.getSnapshot())
      expect(rpc.sendRequest).toHaveBeenCalledTimes(requestsBeforePicks)
      await harness.update({ rpc, fence: 3 })
      for (const id of ['model', 'effort', 'permissionMode']) {
        expect(harness.snapshot().find((row) => row.id === id)?.settable).toBe(true)
      }
      let settled!: Promise<{ snapshot: SessionOptionDescriptor[] }>
      await act(async () => {
        settled = harness.options().optionSurface.setOption('model', 'gpt-host')
      })
      expect(rpc.sendRequest).toHaveBeenCalledWith(
        'agentSession.setOption',
        expect.objectContaining({
          envelope: expect.objectContaining({ expectedRuntimeFence: 3 }),
          key: 'model',
          value: 'gpt-host'
        }),
        expect.any(Object)
      )
      await harness.update({ rpc, fence: 3, enabled: false })
      locked(harness.snapshot())
      await act(async () => {
        pick.resolve()
        locked((await settled).snapshot)
        expect(await harness.options().setStructuredOption('model', 'gpt-host')).toBe(false)
        locked((await harness.options().optionSurface.setOption('model', 'gpt-host')).snapshot)
      })
      expect(harness.onSendError).not.toHaveBeenCalled()
    } finally {
      await harness.unmount()
    }
  })

  it('projects a restored Pi off to the precise supported selection without offering off', async () => {
    const row = {
      id: 'openai/gpt-5',
      label: 'GPT-5',
      isDefault: false,
      efforts: ['minimal', 'low', 'medium', 'high'].map((value) => ({ value, label: value }))
    }
    const rpc = client(
      async () => ({ origin: 'probe', fetchedAt: 1, models: [row] }),
      async () => ({
        models: [row],
        listedModelIds: [row.id],
        current: { model: row.id, effort: 'off', defaulted: [] }
      })
    )
    const harness = await mount({ rpc, fence: 1, agent: 'pi' })
    expect(harness.snapshot().find((entry) => entry.id === 'effort')).toMatchObject({
      settable: true,
      kind: { currentValue: 'minimal', choices: row.efforts }
    })
    await harness.unmount()
  })

  it('shows the quiet placeholder, never the built-in list, until the host answers', async () => {
    let answer!: (value: AgentSessionModelCatalogResult) => void
    const rpc = client(() => new Promise((resolve) => (answer = resolve)))
    const harness = await mount({ rpc, fence: 1 })
    expect(harness.frames.every((choices) => choices.length === 0)).toBe(true)
    await act(async () => answer(HOST_LIST))
    expect(harness.frames.at(-1)).toEqual(['gpt-host'])
    expect(harness.frames.filter((choices) => choices.length > 0)).toEqual(
      harness.frames.filter((choices) => choices.length > 0).map(() => ['gpt-host'])
    )
    await harness.unmount()
  })

  it('keeps unknown options current/permission and paints a later catalog while the recovery read waits', async () => {
    const listing = deferred<AgentSessionModelCatalogResult>()
    const recovery = deferred<AgentSessionOptionsResult>()
    const current = {
      model: 'provider/saved',
      effort: 'high',
      permissionMode: 'ask',
      defaulted: []
    }
    let catalogs = 0
    let reads = 0
    const rpc = client(
      () =>
        ++catalogs === 1
          ? Promise.resolve({ origin: 'unknown', listingInProgress: true })
          : listing.promise,
      () =>
        ++reads === 1
          ? Promise.resolve({ models: [], modelsKnown: false, current })
          : recovery.promise
    )
    const harness = await mount({ rpc, fence: 1, agent: 'omp' })
    const descriptor = (id: string) => harness.snapshot().find((row) => row.id === id)
    try {
      expect(modelChoices(harness.snapshot())).toEqual(['provider/saved'])
      await act(async () => listing.resolve(HOST_LIST))
      expect(reads).toBe(2)
      expect(modelChoices(harness.snapshot())).toEqual(['gpt-host', 'provider/saved'])
      expect(descriptor('model')?.kind.currentValue).toBe('provider/saved')
      expect(descriptor('effort')?.kind.currentValue).toBe('high')
      expect(descriptor('permissionMode')?.kind.currentValue).toBe('ask')
      // A completed empty options answer remains authoritative over later catalog refreshes.
      await act(async () => recovery.resolve({ models: [], current }))
      await act(async () => harness.options().optionSurface.demandModelCatalog?.())
      expect(modelChoices(harness.snapshot())).toEqual(['provider/saved'])
      expect(descriptor('permissionMode')?.kind.currentValue).toBe('ask')
    } finally {
      await harness.unmount()
    }
  })

  it('keeps the host list through a new fence instead of falling back to the placeholder', async () => {
    let reads = 0
    const rpc = client(() => (reads++ === 0 ? Promise.resolve(HOST_LIST) : new Promise(() => {})))
    const harness = await mount({ rpc, fence: 1 })
    expect(harness.frames.at(-1)).toEqual(['gpt-host'])
    const before = harness.frames.length
    await harness.update({ rpc, fence: 2 })
    expect(harness.frames.slice(before).every((choices) => choices[0] === 'gpt-host')).toBe(true)
    await harness.unmount()
  })

  it('makes the built-in list usable when the host refuses the read', async () => {
    const rpc = client(() => Promise.reject(new Error('method_not_found')))
    const harness = await mount({ rpc, fence: 1 })
    expect(harness.frames.at(-1)?.length).toBeGreaterThan(0)
    await harness.unmount()
  })

  it('replaces installed controls while preserving the saved effort', async () => {
    const child: AgentSessionOptionsResult = {
      models: HOST_LIST.models,
      current: { model: 'gpt-host', effort: 'high', permissionMode: 'ask', defaulted: [] }
    }
    let raw = HOST_LIST
    const rpc = client(
      () => Promise.resolve(raw),
      () => Promise.resolve(child)
    )
    const harness = await mount({ rpc, fence: 1 })
    raw = { ...HOST_LIST, models: [] }
    await act(async () => harness.options().optionSurface.demandModelCatalog?.())
    expect(harness.snapshot().find((row) => row.id === 'effort')).toMatchObject({
      settable: false,
      kind: { currentValue: 'high' }
    })
    await harness.unmount()
  })
})
