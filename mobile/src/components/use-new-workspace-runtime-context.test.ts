import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useNewWorkspaceRuntimeContext } from './use-new-workspace-runtime-context'

type RuntimeContext = ReturnType<typeof useNewWorkspaceRuntimeContext>
type PublishedState = Pick<
  RuntimeContext,
  'runtimeSettings' | 'trustedOrcaHooks' | 'availableProviders'
>

// Use the persisted per-repo, per-hook approval shape; a content hash directly under the repo key is unreadable.
const TRUSTED_HOOKS = { 'repo-1': { setup: { contentHash: 'sha-1', approvedAt: 1700000000000 } } }
const UI_WITH_TRUST = { ui: { trustedOrcaHooks: TRUSTED_HOOKS } }
const SETTINGS = { defaultTuiAgent: 'codex', visibleTaskProviders: ['github', 'linear'] }

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

  function Harness({ client }: { client: RpcClient }): null {
    context = useNewWorkspaceRuntimeContext(client, true)
    return null
  }

  // Reuse the mounted harness so the second answer represents a host swap.
  async function answer(settingsResult: unknown, uiResult: unknown): Promise<PublishedState> {
    const element = createElement(Harness, { client: clientAnswering(settingsResult, uiResult) })
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

  it('publishes other source providers while the optional Jira probe is pending', async () => {
    const client = new FakeSession('connected')
    let answerJira: (response: RpcResponse) => void = () => {}
    const pending = new Promise<RpcResponse>((resolve) => {
      answerJira = resolve
    })
    client.sendRequest.mockImplementation((method: string) => {
      if (method === 'jira.status') {
        return pending
      }
      if (method === 'settings.get') {
        return Promise.resolve(reply({ settings: SETTINGS }))
      }
      if (method === 'ui.get') {
        return Promise.resolve(reply(UI_WITH_TRUST))
      }
      if (method === 'preflight.check') {
        return Promise.resolve(reply({ glab: { installed: true } }))
      }
      return Promise.resolve(reply({ connected: true }))
    })
    await act(async () => {
      renderer = create(createElement(Harness, { client }))
    })
    expect(currentContext().availableProviders).toEqual(['github', 'linear'])
    await act(async () => answerJira(reply({ connected: true })))
    expect(currentContext().jiraConnection.connected).toBe(true)
  })

  // A null settings result must still reach the provider commit.
  it.each([
    ['null', null],
    ['absent', undefined],
    ['without a settings member', {}]
  ])('degrades a %s settings result to absent settings', async (_label, settingsResult) => {
    // Jira has no availability gate here, so absent settings still offer it.
    expect(await answer(settingsResult, UI_WITH_TRUST)).toEqual({
      runtimeSettings: null,
      trustedOrcaHooks: TRUSTED_HOOKS,
      availableProviders: ['github', 'jira']
    })
  })

  // A null UI result must not skip the provider commit either.
  it.each([
    ['null', null],
    ['absent', undefined],
    ['without a ui member', {}]
  ])('degrades a %s ui result to untrusted hooks', async (_label, uiResult) => {
    expect(await answer({ settings: SETTINGS }, uiResult)).toEqual({
      runtimeSettings: SETTINGS,
      trustedOrcaHooks: {},
      availableProviders: ['github']
    })
  })

  // Stale trusted hooks would skip the setup-hook approval prompt; assert they are cleared.
  it('blanks the trust an earlier host published when the next ui result is null', async () => {
    expect((await answer({ settings: SETTINGS }, UI_WITH_TRUST)).trustedOrcaHooks).toEqual(
      TRUSTED_HOOKS
    )
    expect((await answer({ settings: SETTINGS }, null)).trustedOrcaHooks).toEqual({})
  })
})
