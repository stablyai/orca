import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSession } from '../../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { useNewWorkspaceRuntimeContext } from './use-new-workspace-runtime-context'

type RuntimeContext = ReturnType<typeof useNewWorkspaceRuntimeContext>
type PublishedState = Pick<
  RuntimeContext,
  'runtimeSettings' | 'trustedOrcaHooks' | 'availableProviders'
>

// Use the persisted per-repo, per-hook approval shape; a content hash directly under the repo key is unreadable.
const TRUSTED_HOOKS = { 'repo-1': { setup: { contentHash: 'sha-1', approvedAt: 1700000000000 } } }
const UI_WITH_TRUST = { ui: { trustedOrcaHooks: TRUSTED_HOOKS } }
const SETTINGS = { defaultTuiAgent: 'codex' as const, visibleTaskProviders: ['github', 'linear'] }

function reply(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function clientAnswering(settingsResult: unknown, uiResult: unknown): RpcClient {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method: string) => {
    switch (method) {
      case 'settings.get':
        return reply(settingsResult)
      case 'ui.get':
        return reply(uiResult)
      case 'preflight.check':
        return reply({ glab: { installed: false } })
      default:
        return reply({ connected: false })
    }
  })
  return client
}

describe('useNewWorkspaceRuntimeContext', () => {
  let renderer: ReactTestRenderer | null = null
  let context: RuntimeContext | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    context = null
  })

  function currentContext(): RuntimeContext {
    if (!context) {
      throw new Error('Runtime context did not render')
    }
    return context
  }

  function Harness({ client, serverId }: { client: RpcClient; serverId?: string }): null {
    context = useNewWorkspaceRuntimeContext(client, true, 'host-1', serverId)
    return null
  }

  // Reuse the mounted harness so the second answer represents a host swap.
  async function answer(
    settingsResult: unknown,
    uiResult: unknown,
    serverId: string
  ): Promise<PublishedState> {
    const element = createElement(Harness, {
      client: clientAnswering(settingsResult, uiResult),
      serverId
    })
    await act(async () => {
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
    await act(async () => {})
    const { runtimeSettings, trustedOrcaHooks, availableProviders } = context!
    return { runtimeSettings, trustedOrcaHooks, availableProviders }
  }

  async function swapToUnansweredClient(serverId: string): Promise<void> {
    const next = new FakeSession('connected')
    next.sendRequest.mockImplementation(() => new Promise<RpcResponse>(() => {}))
    await act(async () => renderer?.update(createElement(Harness, { client: next, serverId })))
  }

  it('does not show the previous host settings or approvals while the new host has not answered', async () => {
    await answer({ settings: SETTINGS }, UI_WITH_TRUST, 'runtime:a')
    await swapToUnansweredClient('runtime:b')
    expect(currentContext().runtimeSettings).toBeNull()
    expect(currentContext().trustedOrcaHooks).toEqual({})
    expect(currentContext().availableProviders).toEqual([])
  })

  // A -> B -> A: the first A's Save callbacks must stay retired when A is picked again.
  it('ignores publishers from an earlier selection, including of the same host', async () => {
    let ui: unknown = UI_WITH_TRUST
    const first = new FakeSession('connected')
    first.sendRequest.mockImplementation(async (method: string) =>
      reply(method === 'ui.get' ? ui : method === 'settings.get' ? { settings: SETTINGS } : {})
    )
    await act(async () => {
      renderer = create(createElement(Harness, { client: first, serverId: 'runtime:a' }))
    })
    const retired = currentContext()
    expect(retired.trustedOrcaHooks).toEqual(TRUSTED_HOOKS)

    await answer({ settings: { defaultTuiAgent: 'claude' } }, { ui: {} }, 'runtime:b')
    act(() => {
      retired.setRuntimeSettings(SETTINGS)
      retired.setTrustedOrcaHooks(TRUSTED_HOOKS)
    })
    expect(currentContext().runtimeSettings).toEqual({ defaultTuiAgent: 'claude' })
    expect(currentContext().trustedOrcaHooks).toEqual({})

    ui = { ui: {} }
    await act(async () =>
      renderer?.update(createElement(Harness, { client: first, serverId: 'runtime:a' }))
    )
    act(() => retired.setTrustedOrcaHooks(TRUSTED_HOOKS))
    expect(currentContext().trustedOrcaHooks).toEqual({})
  })
})
