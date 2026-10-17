import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { useMobileStructuredSessionOptionStamp } from './use-mobile-structured-session-option-stamp'

const HOST_LIST: AgentSessionModelCatalogResult = {
  origin: 'probe',
  models: [{ id: 'gpt-host', label: 'GPT Host', isDefault: true, efforts: [] }],
  fetchedAt: 1_000
}

/** Catalog reads take each scripted answer in turn; option reads never answer. */
function client(
  catalog: () => Promise<AgentSessionModelCatalogResult>,
  options: () => Promise<unknown> = () => new Promise(() => {}),
  subscribe: RpcClient['subscribe'] = () => () => {}
): RpcClient {
  return {
    sendRequest: async (method: string) =>
      method === 'agentSession.modelCatalog'
        ? { id: 'rpc-1', ok: true as const, result: await catalog(), _meta: { runtimeId: 'r' } }
        : { id: 'rpc-2', ok: true as const, result: await options(), _meta: { runtimeId: 'r' } },
    subscribe,
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

type Props = { rpc: RpcClient; fence: number; agent?: string }

async function mount(initial: Props) {
  const frames: string[][] = []
  const mutate: StructuredAgentSessionMutate = vi.fn()
  function Probe(props: Props): null {
    const optionStamp = useMobileStructuredSessionOptionStamp({
      client: props.rpc,
      sessionId: 'session-1',
      enabled: true
    })
    const options = useMobileStructuredAgentOptions({
      agent: props.agent ?? 'codex',
      client: props.rpc,
      sessionId: 'session-1',
      enabled: true,
      fence: props.fence,
      mutate,
      optionStamp,
      hostSupport: { sendOptions: true, permissionModes: true }
    })
    frames.push(modelChoices(options.optionSnapshot))
    return null
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Probe, initial))
  })
  return {
    frames,
    update: (next: Props) =>
      act(async () => {
        renderer?.update(createElement(Probe, next))
      }),
    unmount: () => act(async () => renderer?.unmount())
  }
}

describe('the phone picker’s first frame', () => {
  it.each([true, false])(
    're-reads same-fence readiness and discards late startup answers (early=%s)',
    async (early) => {
      const catalogs: ((answer: AgentSessionModelCatalogResult) => void)[] = []
      const options: ((answer: unknown) => void)[] = []
      let status: (frame: unknown) => void = () => {}
      const rpc = client(
        () => new Promise((resolve) => catalogs.push(resolve)),
        () => new Promise((resolve) => options.push(resolve)),
        (_method, _params, listener) => {
          status = listener
          return () => {}
        }
      )
      const harness = await mount({ rpc, fence: 1, agent: 'claude' })
      const phase = (hostExecutionPhase: string) =>
        status({
          type: 'status',
          session: {
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            agent: 'claude',
            status: 'idle',
            updatedAt: 1,
            model: 'gpt-host',
            hostExecutionPhase
          }
        })
      await act(async () => phase('starting'))
      const empty = {
        authority: 'session' as const,
        scopeId: 'process-1',
        models: [],
        complete: false,
        freshForMs: 0
      }
      const startup = async () => {
        for (const answer of catalogs.slice(0, 2)) {
          answer({ origin: 'unknown', choiceCatalog: empty })
        }
        for (const answer of options.slice(0, 2)) {
          answer({
            models: [],
            current: { model: 'gpt-host' },
            choiceCatalog: empty,
            choiceAuthority: 'session'
          })
        }
      }
      if (early) {
        await act(startup)
      }
      await act(async () => phase('ready'))
      expect(catalogs).toHaveLength(3)
      expect(options).toHaveLength(3)
      const ready = {
        ...empty,
        complete: true,
        models: HOST_LIST.origin === 'unknown' ? [] : HOST_LIST.models
      }
      await act(async () => {
        catalogs[2]?.({ ...HOST_LIST, choiceCatalog: ready })
        options[2]?.({
          models: ready.models,
          current: { model: 'gpt-host' },
          choiceCatalog: ready,
          choiceAuthority: 'session'
        })
      })
      if (!early) {
        await act(startup)
      }
      expect(harness.frames.at(-1)).toEqual(['gpt-host'])
      await harness.unmount()
    }
  )

  it('shows the quiet placeholder, never the built-in list, until the host answers', async () => {
    let answer!: (value: AgentSessionModelCatalogResult) => void
    const rpc = client(() => new Promise((resolve) => (answer = resolve)))
    const harness = await mount({ rpc, fence: 1 })
    expect(harness.frames.every((choices) => choices.length === 0)).toBe(true)
    await act(async () => answer(HOST_LIST))
    expect(harness.frames.at(-1)).toEqual(['gpt-host'])
    // Only the host's list was ever offered.
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
})
