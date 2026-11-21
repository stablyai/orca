import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import { stubRpcClient } from '../../../../transport/rpc/rpc-client-test-stub'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { useMobileNativeChatModelDiscovery } from './use-mobile-native-chat-model-discovery'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function discoveryReply(id: string) {
  return {
    id: 'git.discoverCommitMessageModels',
    ok: true as const,
    result: {
      success: true,
      catalogOrigin: 'probe' as const,
      models: [{ id, label: id }]
    }
  }
}

describe('useMobileNativeChatModelDiscovery', () => {
  it('does not reuse an in-flight probe when the RPC client changes', async () => {
    const first = deferred<ReturnType<typeof discoveryReply>>()
    const second = deferred<ReturnType<typeof discoveryReply>>()
    const clientA = stubRpcClient({
      sendRequest: vi.fn(() => first.promise)
    })
    const clientB = stubRpcClient({
      sendRequest: vi.fn(() => second.promise)
    })
    const discovered: { models: CatalogModel[] | null } = { models: null }
    let renderer: ReactTestRenderer | null = null

    function Probe(props: { client: RpcClient }): null {
      discovered.models = useMobileNativeChatModelDiscovery({
        client: props.client,
        agent: 'claude',
        hostId: 'host',
        worktreeId: 'worktree',
        enabled: true
      }).models
      return null
    }

    await act(async () => {
      renderer = create(createElement(Probe, { client: clientA }))
      await Promise.resolve()
    })
    expect(clientA.sendRequest).toHaveBeenCalledTimes(1)
    expect(clientB.sendRequest).not.toHaveBeenCalled()

    await act(async () => {
      renderer?.update(createElement(Probe, { client: clientB }))
      await Promise.resolve()
    })
    expect(clientB.sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(discoveryReply('from-a'))
      await first.promise
      await Promise.resolve()
    })
    expect(discovered.models?.some((model) => model.id === 'from-a')).toBeFalsy()

    await act(async () => {
      second.resolve(discoveryReply('from-b'))
      await second.promise
      await Promise.resolve()
    })
    expect(discovered.models?.some((model) => model.id === 'from-b')).toBe(true)

    act(() => {
      renderer?.unmount()
    })
  })
})
