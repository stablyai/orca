import { expect, it, vi } from 'vitest'
import { getProjectSectionsResource } from './project-sections-resource'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { RpcClientStreamRegistry } from '../transport/rpc-client-stream-registry'
import { CLIENT_EVENT_METHODS } from '../../../src/main/runtime/rpc/methods/client-events'
import type { RpcResponse } from '../transport/types'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { partialRuntimeStore } from '../../../src/main/runtime/runtime-store-partial-fixture'
import { MOBILE_PROJECT_SECTIONS_METHODS } from '../../../src/main/runtime/rpc/methods/mobile-project-sections'
import { publishMobileProjectSections } from '../../../src/main/runtime/mobile-project-sections-snapshot'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../src/shared/runtime-types'
import { mapRuntimeError, successResponse } from '../../../src/main/runtime/rpc/errors'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { fromId: () => ({ isDestroyed: () => false }) }
}))

it('answers only known owner input and wakes pending readers after real headless restoration', async () => {
  vi.useFakeTimers()
  const create = () =>
    new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [],
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getSettings: () => ({ workspaceDir: '/tmp/workspaces' })
      })
    )
  const method = MOBILE_PROJECT_SECTIONS_METHODS[0]
  const read = (runtime: OrcaRuntimeService) => method.handler(undefined, { runtime })
  try {
    const desktop = create()
    expect(() => read(desktop)).toThrow('runtime_unavailable')
    desktop.attachWindow(1)
    expect(() => read(desktop)).toThrow('runtime_unavailable')
    desktop.syncWindowGraph(1, { tabs: [], leaves: [], rendererGeneration: 'first' })
    expect(() => read(desktop)).toThrow('runtime_unavailable')
    const runtime = create()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    expect(await read(runtime)).toEqual({ catalog: null })
    const wake = vi.spyOn(runtime, 'notifyReposChangedForRemoteClients')
    runtime.attachWindow(2)
    let sequence = 0
    let dispatches = 0
    const tracker: RpcClientRequestTracker = new RpcClientRequestTracker({
      nextId: () => String(++sequence),
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendFrame: (frame) => {
        dispatches++
        void Promise.resolve()
          .then(() => read(runtime))
          .then(
            (result) => tracker.resolve(successResponse(frame.id, { runtimeId: 'owner' }, result)),
            (error) => tracker.resolve(mapRuntimeError(frame.id, { runtimeId: 'owner' }, error))
          )
        return true
      }
    })
    const client = stubRpcClient({
      sendRequest: tracker.sendRequest.bind(tracker),
      subscribe: (_method, _params, onData) =>
        runtime.onClientEvent(onData, { consumesTerminalSideEffects: false })
    })
    const resource = getProjectSectionsResource(client)
    const release = resource.subscribe(() => {}, { addEventListener: () => ({ remove: () => {} }) })
    await resource.refresh(false)
    expect(resource.getSnapshot()).toEqual({ kind: 'pending' })
    expect(tracker.size()).toBe(0)
    expect(dispatches).toBe(1)
    expect(() => read(runtime)).toThrow('runtime_unavailable')
    runtime.markGraphReloadFailed(2, 'renderer-process-gone')
    expect(await read(runtime)).toEqual({ catalog: null })
    expect(wake).toHaveBeenCalledTimes(1)
    await resource.refresh(false)
    expect(resource.getSnapshot()).toEqual({ kind: 'answered', value: null })
    expect(tracker.size()).toBe(0)
    expect(dispatches).toBe(2)
    // A late healthy graph from the pending promotion is still accepted, but graph-ready alone is not a catalog.
    runtime.syncWindowGraph(2, { tabs: [], leaves: [], rendererGeneration: 'late' })
    expect(() => read(runtime)).toThrow('runtime_unavailable')
    const catalog = { repos: [], projects: [], setups: [], projectOrderBy: 'manual' as const }
    expect(publishMobileProjectSections(catalog)).toBe(true)
    runtime.notifyReposChangedForRemoteClients()
    await resource.refresh(false)
    expect(resource.getSnapshot()).toEqual({ kind: 'answered', value: catalog })
    expect(tracker.size()).toBe(0)
    expect(await read(runtime)).toEqual({ catalog })
    expect(publishMobileProjectSections(structuredClone(catalog))).toBe(false)
    runtime.markRendererReloading(2)
    expect(await read(runtime)).toEqual({ catalog })
    runtime.markGraphUnavailable(2)
    expect(await read(runtime)).toEqual({ catalog })
    release()
    wake.mockRestore()
  } finally {
    vi.useRealTimers()
  }
})

it.each([false, true])(
  'releases the real server registration through the stream registry with ready delayed=%s',
  async (delayReady) => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [],
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getSettings: () => ({ workspaceDir: '/tmp/workspaces' })
      })
    )
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const catalog = { repos: [], projects: [], setups: [], projectOrderBy: 'manual' as const }
    publishMobileProjectSections(catalog)
    const context = {
      runtime,
      connectionId: 'owner-resource-release',
      clientKind: 'mobile' as const
    }
    const registered = vi.spyOn(runtime, 'registerSubscriptionCleanup')
    const cleaned = vi.spyOn(runtime, 'cleanupSubscription')
    let sequence = 0
    const sent: RpcRequestFrame[] = []
    const held: RpcResponse[] = []
    const tasks: Promise<unknown>[] = []
    const tracker = new RpcClientRequestTracker({
      nextId: () => String(++sequence),
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendFrame: (frame) => {
        sent.push(frame)
        tasks.push(
          Promise.resolve()
            .then(() => MOBILE_PROJECT_SECTIONS_METHODS[0].handler(undefined, context))
            .then((result) =>
              tracker.resolve(successResponse(frame.id, { runtimeId: 'owner' }, result))
            )
        )
        return true
      }
    })
    const subscribeMethod = CLIENT_EVENT_METHODS[0]
    const unsubscribeMethod = CLIENT_EVENT_METHODS[1]
    if (
      subscribeMethod.name !== 'runtime.clientEvents.subscribe' ||
      unsubscribeMethod.name !== 'runtime.clientEvents.unsubscribe'
    ) {
      throw new Error('Missing expected client event methods')
    }
    const streams = new RpcClientStreamRegistry({
      nextId: () => String(++sequence),
      getState: () => 'connected',
      sendFrame: (frame) => {
        sent.push(frame)
        if (frame.method === 'runtime.clientEvents.subscribe') {
          tasks.push(
            subscribeMethod.handler(undefined, context, (result) => {
              const reply = {
                ...successResponse(frame.id, { runtimeId: 'owner' }, result),
                streaming: true as const
              }
              if (
                delayReady &&
                result !== null &&
                typeof result === 'object' &&
                Reflect.get(result, 'type') === 'ready'
              ) {
                held.push(reply)
              } else {
                streams.handleResponse(reply)
              }
            })
          )
        } else if (frame.method === 'runtime.clientEvents.unsubscribe') {
          const params = unsubscribeMethod.params.parse(frame.params)
          tasks.push(Promise.resolve(unsubscribeMethod.handler(params, context)))
        }
        return true
      }
    })
    const client = stubRpcClient({
      sendRequest: tracker.sendRequest.bind(tracker),
      subscribe: streams.subscribe.bind(streams)
    })
    const resource = getProjectSectionsResource(client)
    const flush = async () => {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve()
      }
    }
    const release = resource.subscribe(() => {}, { addEventListener: () => ({ remove: () => {} }) })
    try {
      await flush()
      expect(resource.getSnapshot()).toEqual({ kind: 'answered', value: catalog })
      expect(registered).toHaveBeenCalledOnce()
      expect(streams.size()).toBe(1)
      release()
      if (delayReady) {
        expect(
          sent.filter((frame) => frame.method === 'runtime.clientEvents.unsubscribe')
        ).toHaveLength(0)
        expect(held).toHaveLength(1)
        streams.handleResponse(held[0])
      }
      await Promise.all(tasks)
      await flush()
      const subscriptionId = registered.mock.calls[0][0]
      expect(sent.filter((frame) => frame.method === 'runtime.clientEvents.unsubscribe')).toEqual([
        expect.objectContaining({ params: { subscriptionId } })
      ])
      expect(cleaned).toHaveBeenCalledExactlyOnceWith(subscriptionId)
      expect(streams.size()).toBe(0)
      expect(tracker.size()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      const count = sent.length
      runtime.notifyReposChangedForRemoteClients()
      await flush()
      expect(sent).toHaveLength(count)
    } finally {
      release()
      runtime.cleanupSubscriptionsForConnection(context.connectionId)
      registered.mockRestore()
      cleaned.mockRestore()
      vi.useRealTimers()
    }
  }
)
