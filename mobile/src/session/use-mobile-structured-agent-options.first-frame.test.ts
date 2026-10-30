import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

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

type Props = { rpc: RpcClient; fence: number; agent?: 'pi' | 'codex' }

async function mount(initial: Props) {
  const frames: string[][] = []
  const effortFrames: (boolean | undefined)[] = []
  let snapshot: readonly SessionOptionDescriptor[] = []
  const mutate = vi.fn().mockResolvedValue({ status: 'rejected' })
  let latest!: ReturnType<typeof useMobileStructuredAgentOptions>
  function Probe(props: Props): null {
    const options = useMobileStructuredAgentOptions({
      agent: props.agent ?? 'codex',
      client: props.rpc,
      sessionId: 'session-1',
      enabled: true,
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
    mutate,
    update: (next: Props) =>
      act(async () => {
        renderer?.update(createElement(Probe, next))
      }),
    unmount: () => act(async () => renderer?.unmount())
  }
}

describe('the phone picker’s first frame', () => {
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
