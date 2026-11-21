import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { stubRpcClient } from '../../../../transport/rpc/rpc-client-test-stub'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { useMobileNativeChatModelDiscovery } from './use-mobile-native-chat-model-discovery'
import {
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

const routeA = 'provider-a/claude-sonnet-5-5'
const routeB = 'provider-b/claude-sonnet-5-5'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function listed(ids: readonly string[]) {
  return {
    id: 'git.discoverCommitMessageModels',
    ok: true as const,
    result: {
      success: true as const,
      catalogOrigin: 'probe' as const,
      models: ids.map((id) => ({ id, label: id }))
    }
  }
}

function failed() {
  return {
    id: 'git.discoverCommitMessageModels',
    ok: true as const,
    result: { success: false as const }
  }
}

function modelSelect(snapshot: readonly SessionOptionDescriptor[]) {
  const model = snapshot.find((entry) => entry.id === 'model')
  if (!model || model.kind.type !== 'select') {
    throw new Error('model select missing')
  }
  return model.kind
}

describe('Chat to Terminal to Chat model discovery', () => {
  it('hides stale discovered routes while the return probe is pending', async () => {
    const first = deferred<ReturnType<typeof listed>>()
    const second = deferred<ReturnType<typeof listed>>()
    let calls = 0
    const client = stubRpcClient({
      sendRequest: vi.fn(() => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      })
    })
    const view = mountRoundTrip(client)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve(listed([routeA, routeB]))
      await first.promise
    })
    expect(modelSelect(view.api.snapshot).choices.map((choice) => choice.value)).toContain(routeB)

    view.update({ chat: false })
    view.update({ chat: true })
    expect(modelSelect(view.api.snapshot).choices.map((choice) => choice.value)).not.toContain(
      routeB
    )
    view.unmount()
  })

  it('drops a tracked discovered route after the return probe fails', async () => {
    const first = deferred<ReturnType<typeof listed>>()
    const second = deferred<ReturnType<typeof failed>>()
    let calls = 0
    const client = stubRpcClient({
      sendRequest: vi.fn(() => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      })
    })
    const view = mountRoundTrip(client, routeA)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve(listed([routeA, routeB]))
      await first.promise
    })
    await act(async () => {
      await view.api.setOption('model', routeB)
    })
    expect(modelSelect(view.api.snapshot).currentValue).toBe(routeB)

    view.update({ chat: false })
    view.update({ chat: true })
    await act(async () => {
      second.resolve(failed())
      await second.promise
    })
    const model = modelSelect(view.api.snapshot)
    expect(model.currentValue).not.toBe(routeB)
    expect(model.choices.map((choice) => choice.value)).not.toContain(routeA)
    expect(model.choices.map((choice) => choice.value)).not.toContain(routeB)
    view.unmount()
  })

  it('reapplies the reported route after a terminal round trip', async () => {
    const first = deferred<ReturnType<typeof listed>>()
    const second = deferred<ReturnType<typeof listed>>()
    let calls = 0
    const client = stubRpcClient({
      sendRequest: vi.fn(() => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      })
    })
    const view = mountRoundTrip(client, routeA)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve(listed([routeA, routeB]))
      await first.promise
    })
    expect(modelSelect(view.api.snapshot).currentValue).toBe(routeA)
    await act(async () => {
      await view.api.setOption('model', routeB)
    })
    expect(modelSelect(view.api.snapshot).currentValue).toBe(routeB)

    view.update({ chat: false })
    view.update({ chat: true })
    await act(async () => {
      second.resolve(listed([routeA, routeB]))
      await second.promise
    })
    expect(modelSelect(view.api.snapshot).currentValue).toBe(routeA)
    view.unmount()
  })

  it('keeps a selected provider route when a bare status report survives a successful refresh', async () => {
    const bare = 'claude-sonnet-5-5'
    const first = deferred<ReturnType<typeof listed>>()
    const second = deferred<ReturnType<typeof listed>>()
    let calls = 0
    const client = stubRpcClient({
      sendRequest: vi.fn(() => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      })
    })
    const view = mountRoundTrip(client, bare)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve(listed([bare, routeA, routeB]))
      await first.promise
    })
    await act(async () => {
      await view.api.setOption('model', routeB)
    })
    expect(modelSelect(view.api.snapshot).currentValue).toBe(routeB)

    view.update({ chat: false })
    view.update({ chat: true })
    const pending = modelSelect(view.api.snapshot)
    expect(pending.currentValue).toBe(routeB)
    expect(pending.choices.map((choice) => choice.value)).not.toContain(routeA)

    await act(async () => {
      second.resolve(listed([bare, routeA, routeB]))
      await second.promise
    })
    expect(modelSelect(view.api.snapshot).currentValue).toBe(routeB)
    view.unmount()
  })

  it('drops a selected route the refreshed catalog no longer lists', async () => {
    const first = deferred<ReturnType<typeof listed>>()
    const second = deferred<ReturnType<typeof listed>>()
    let calls = 0
    const client = stubRpcClient({
      sendRequest: vi.fn(() => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      })
    })
    const view = mountRoundTrip(client)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve(listed([routeA, routeB]))
      await first.promise
    })
    await act(async () => {
      await view.api.setOption('model', routeB)
    })
    view.update({ chat: false })
    view.update({ chat: true })
    await act(async () => {
      second.resolve(listed([routeA]))
      await second.promise
    })
    expect(modelSelect(view.api.snapshot).currentValue).not.toBe(routeB)
    view.unmount()
  })

  it('keeps a selected provider route when the chat remounts before discovery settles', async () => {
    const bare = 'claude-sonnet-5-5'
    const first = deferred<ReturnType<typeof listed>>()
    const second = deferred<ReturnType<typeof listed>>()
    let calls = 0
    const client = stubRpcClient({
      sendRequest: vi.fn(() => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      })
    })
    const hostId = `remount-${randomUUID()}`
    const view = mountRoundTrip(client, bare, hostId)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve(listed([bare, routeA, routeB]))
      await first.promise
    })
    await act(async () => {
      await view.api.setOption('model', routeB)
    })
    expect(modelSelect(view.api.snapshot).currentValue).toBe(routeB)
    view.unmount()

    const again = mountRoundTrip(client, bare, hostId)
    expect(modelSelect(again.api.snapshot).currentValue).toBe(routeB)
    await act(async () => {
      second.resolve(listed([bare, routeA, routeB]))
      await second.promise
    })
    expect(modelSelect(again.api.snapshot).currentValue).toBe(routeB)
    again.unmount()
  })
})

function mountRoundTrip(
  client: RpcClient,
  reported: string | null = null,
  hostId = `round-trip-${randomUUID()}`
) {
  const scopeKey = `${hostId}\0worktree\0tab`
  const dispatchCommand = vi.fn(async () => 'accepted' as const)
  let renderer: ReactTestRenderer | null = null
  let api: MobileNativeChatSessionOptionsController | null = null
  let chat = true
  let reportedModel = reported

  function Probe(): null {
    const discovered = useMobileNativeChatModelDiscovery({
      client,
      agent: 'claude',
      hostId,
      worktreeId: 'worktree',
      enabled: chat
    })
    api = useMobileNativeChatSessionOptions({
      agent: 'claude',
      scopeKey,
      reportedModel,
      discoveredModels: discovered.models,
      discoveryFailed: discovered.failed,
      chatVisible: chat,
      dispatchCommand
    })
    return null
  }

  act(() => {
    renderer = create(createElement(Probe))
  })
  return {
    get api() {
      if (!api) {
        throw new Error('session options missing')
      }
      return api
    },
    update(next: { chat?: boolean; reported?: string | null }) {
      if (next.chat !== undefined) {
        chat = next.chat
      }
      if (next.reported !== undefined) {
        reportedModel = next.reported
      }
      act(() => {
        renderer?.update(createElement(Probe))
      })
    },
    unmount() {
      act(() => {
        renderer?.unmount()
      })
    }
  }
}
