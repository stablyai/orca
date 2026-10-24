import { createElement, useSyncExternalStore, useCallback, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileSessionTab as Tab } from './mobile-session-route-types'
import { expect, it, vi } from 'vitest'
import type { TerminalInterfaceObservation } from '../../../src/shared/terminal-interface-observation'
import { resolveMobileNativeChat, canShowMobileNativeChat } from './mobile-native-chat-eligibility'

it('joins listener-first phone observations independently of structural tabs, retracts late tabs and owns client cleanup', async () => {
  const { scopeRpcClientToExecutionHost } =
    await import('../transport/execution-host-scoped-rpc-client')
  const { mobileTerminalInterfaceReplica, deriveMobileTerminalInterfaces } =
    await import('./mobile-terminal-interface-replica')
  const { createStableLogicalRpcClient } = await import('../transport/stable-logical-rpc-client')
  const observation: TerminalInterfaceObservation = {
    ptyId: 'physical',
    incarnationId: 'birth',
    terminalHandle: 'handle',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    worktreeId: 'repo::C:/work',
    epoch: 'host',
    revision: 1,
    inputRevision: 0,
    owner: null,
    executionLaunchToken: null,
    state: 'shell',
    basis: 'hook'
  }
  const frame = (
    revision: number,
    observations: TerminalInterfaceObservation[],
    epoch = 'host'
  ) => ({ type: 'terminalInterfaces', epoch, revision, observations })
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const active = new Set<(value: unknown) => void>()
  const history: ((value: unknown) => void)[] = []
  let state: ConnectionState = 'connected'
  let replay = observation
  let asynchronousReplay = false
  let openingFailure: unknown = null
  const serverHistory: ((value: unknown) => void)[] = []
  const serverActive = new Set<(value: unknown) => void>()
  const replayGenerations: number[] = []
  vi.useFakeTimers()
  const physical: RpcClient = {
    sendRequest: vi.fn(),
    subscribe: vi.fn<RpcClient['subscribe']>((_method, _params, listener, options) => {
      active.add(listener)
      history.push(listener)
      const server = options?.envelope?.executionHost === 'runtime:server'
      if (server) {
        serverHistory.push(listener)
        serverActive.add(listener)
      }
      const deliver = () => {
        replayGenerations.push(client.getGeneration())
        listener(frame(replay.revision, [replay], replay.epoch))
        listener({ type: 'ready' })
      }
      if (server && openingFailure) {
        listener(openingFailure)
      } else if (asynchronousReplay) {
        void Promise.resolve().then(deliver)
      } else {
        deliver()
      }
      return () => {
        active.delete(listener)
        serverActive.delete(listener)
      }
    }),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: (listener) => {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  const client = createStableLogicalRpcClient(physical, 'lan')
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const replica = mobileTerminalInterfaceReplica(client)
  const emit = (value: unknown) => {
    for (const listener of active) {
      listener(value)
    }
  }
  const setState = (next: ConnectionState) => {
    state = next
    for (const listener of stateListeners) {
      listener(next)
    }
    renderer?.update(createElement(Probe))
    secondRenderer?.update(createElement(Probe))
  }
  const accepted: Tab = {
    type: 'terminal',
    id: 'tab',
    parentTabId: 'tab',
    leafId: '11111111-1111-4111-8111-111111111111',
    title: 'Agent',
    terminal: 'handle',
    incarnationId: 'birth',
    status: 'ready',
    launchAgent: 'codex',
    launchDraft: 'Keep context',
    isActive: true
  }
  const browser: Tab = {
    type: 'browser',
    id: 'browser',
    browserPageId: 'page',
    browserWorkspaceId: 'repo::C:/work',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    title: 'Current browser',
    url: 'https://current.test/',
    isActive: false
  }
  let structural: Tab[] = []
  let derived: Tab[] = []
  let resolution: ReturnType<typeof resolveMobileNativeChat> = null
  const toggleAvailable = () =>
    canShowMobileNativeChat(derived.find((tab) => tab.type === 'terminal') ?? null, true)
  function Probe() {
    const observations = useSyncExternalStore(
      useCallback(
        (listener: () => void) => (state === 'connected' ? replica.subscribe(listener) : () => {}),
        [state]
      ),
      replica.read
    )
    derived = deriveMobileTerminalInterfaces(structural, observations, 'repo::c:\\work')
    resolution = resolveMobileNativeChat(
      derived.find((tab) => tab.type === 'terminal') ?? null,
      true
    )
    return null
  }
  let renderer: ReactTestRenderer | undefined
  let secondRenderer: ReactTestRenderer | undefined
  const scopedRenderers: ReactTestRenderer[] = []
  try {
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    expect(replica.read().get('handle')).toEqual(observation) // Replay survives the following ready.
    expect(physical.subscribe).toHaveBeenCalledTimes(1)
    await act(async () => {
      secondRenderer = create(createElement(Probe))
    })
    expect(physical.subscribe).toHaveBeenCalledTimes(1)
    structural = [accepted, browser]
    await act(async () => renderer?.update(createElement(Probe)))
    expect(resolution !== null).toBe(false) // Observation preceded the matching tab.
    expect(toggleAvailable()).toBe(false)
    expect(derived[1]).toBe(browser)
    expect(accepted).not.toHaveProperty('terminalInterface')
    await act(async () => emit(frame(2, [])))
    structural = [{ ...accepted }, browser] // A later structural publication cannot restore a retracted value.
    await act(async () => renderer?.update(createElement(Probe)))
    expect(derived[0]).not.toHaveProperty('terminalInterface', observation)
    expect(resolution !== null).toBe(true)
    expect(toggleAvailable()).toBe(true)
    await act(async () => {
      emit(frame(1, [observation])) // Older same-epoch frame is rejected.
      emit(frame(3, [{ ...observation, incarnationId: 'replacement', revision: 3 }]))
    })
    expect(resolution !== null).toBe(true)
    await act(async () => emit(frame(4, [{ ...observation, revision: 4 }])))
    expect(resolution !== null).toBe(false)
    await act(async () => emit(frame(0, [], 'restarted-host')))
    await act(async () => emit(frame(5, [{ ...observation, revision: 5 }])))
    expect(resolution !== null).toBe(true) // Retired host epoch cannot return.
    const retiredConnection = history.at(-1)!
    await act(async () => setState('disconnected'))
    expect(replica.read().size).toBe(0)
    expect(active.size).toBe(0)
    await act(async () => setState('connected'))
    expect(resolution !== null).toBe(false)
    await act(async () => retiredConnection(frame(99, [])))
    expect(replica.read().get('handle')).toEqual(observation)
    expect(physical.sendRequest).not.toHaveBeenCalled() // No fetch, persistence or invalidation on observation.
    expect(accepted.launchDraft).toBe('Keep context')
    const previousGeneration = client.getGeneration()
    const preMigration = history.at(-1)!
    replay = { ...observation, revision: 20 }
    asynchronousReplay = true
    await act(async () => client.migrateTo({ ...physical, close: vi.fn() }, 'relay'))
    expect(client.getGeneration()).toBeGreaterThan(previousGeneration)
    expect(replica.read().size).toBe(0)
    await advance(2000)
    expect(replayGenerations.at(-1)).toBe(client.getGeneration())
    expect(replica.read().get('handle')).toEqual(replay) // Distinct asynchronous replay before ready.
    await act(async () => preMigration(frame(100, [])))
    expect(replica.read().get('handle')).toEqual(replay)
    await act(async () => {
      secondRenderer?.unmount()
      renderer?.unmount()
    })
    expect(active.size).toBe(0) // Last consumer removes the feed and retry owner.
    expect(vi.getTimerCount()).toBe(0)
    expect(mobileTerminalInterfaceReplica(client)).toBe(replica)
    const remaining = mobileTerminalInterfaceReplica(client)
    let stop!: () => void
    let stopRemounted!: () => void
    await act(async () => {
      stop = remaining.subscribe(() => {})
      stopRemounted = replica.subscribe(() => {})
    })
    expect(active.size).toBe(1) // A remount and a new consumer still share the logical client feed.
    const scoped = scopeRpcClientToExecutionHost(client, 'runtime:server')
    const serverReplica = mobileTerminalInterfaceReplica(scoped)
    const serverState: ConnectionState = 'connected'
    let serverResolution: ReturnType<typeof resolveMobileNativeChat> = null
    let serverToggle = false
    const serverTabs = [accepted, browser]
    const serverResults = new Map<boolean, { chat: boolean; toggle: boolean; preference: string }>()
    function ServerProbe({ focused }: { focused: boolean }) {
      const [preference] = useState('terminal')
      const observations = useSyncExternalStore(
        useCallback(
          (listener: () => void) =>
            serverState === 'connected' ? serverReplica.subscribe(listener) : () => {},
          [serverState]
        ),
        serverReplica.read
      )
      const tab = deriveMobileTerminalInterfaces(
        serverTabs,
        observations,
        observation.worktreeId
      )[0]!
      serverResolution = resolveMobileNativeChat(tab, true)
      serverToggle = canShowMobileNativeChat(tab, true)
      serverResults.set(focused, {
        chat: serverResolution !== null,
        toggle: serverToggle,
        preference
      })
      return null
    }
    await act(async () => {
      scopedRenderers.push(
        create(createElement(ServerProbe, { focused: true })),
        create(createElement(ServerProbe, { focused: false }))
      )
    })
    expect(active.size).toBe(2) // One desktop feed and one server feed, shared by two mounted consumers each.
    expect(serverResolution !== null).toBe(false)
    expect(serverToggle).toBe(false)
    expect(serverHistory).toHaveLength(1)
    for (const type of ['error', 'end', 'close']) {
      const oldServerFrame = serverHistory.at(-1)!
      const before = serverHistory.length
      await act(async () => {
        oldServerFrame({ type, error: { code: 'remote_runtime_unavailable' } })
        oldServerFrame(frame(88, [observation]))
      })
      expect(serverReplica.read().size).toBe(0)
      expect(serverActive.size).toBe(0) // The ended logical record is disposed immediately.
      expect(serverResults.get(false)?.chat).toBe(true)
      expect(serverResults.get(false)?.toggle).toBe(true)
      expect(serverState).toBe('connected')
      expect(client.getState()).toBe('connected')
      expect(scoped.getState()).toBe('connected')
      if (type === 'error') {
        // A relay-only short outage never changes either rendered connection state.
        await advance(500)
        await act(async () => client.migrateTo({ ...physical, close: vi.fn() }, 'lan'))
        expect(serverHistory).toHaveLength(before) // Migration cannot reattach the ended record.
        await advance(1499)
        expect(serverHistory).toHaveLength(before)
        replay = { ...observation, revision: 30 }
        await advance(1)
      } else {
        replay = { ...observation, revision: replay.revision + 1 }
        await advance(2000)
      }
      expect(serverHistory).toHaveLength(before + 1)
      expect(serverActive.size).toBe(1) // Both continuously mounted consumers share recovery.
      expect(serverReplica.read().get('handle')).toEqual(replay)
      expect(replayGenerations.at(-1)).toBe(client.getGeneration())
      expect(serverResults.get(true)).toEqual({
        chat: false,
        toggle: false,
        preference: 'terminal'
      })
      expect(serverResults.get(false)).toEqual({
        chat: false,
        toggle: false,
        preference: 'terminal'
      })
      await act(async () => oldServerFrame(frame(99, [])))
      expect(serverReplica.read().get('handle')).toEqual(replay)
      expect(accepted).not.toHaveProperty('terminalInterface')
      expect(serverTabs[0]).toBe(accepted)
      expect(serverTabs[1]).toBe(browser)
      expect(accepted.launchDraft).toBe('Keep context')
      expect(physical.sendRequest).not.toHaveBeenCalled()
    }
    const beforeContactLoss = serverHistory.length
    const oldContact = serverHistory.at(-1)!
    await act(async () => {
      state = 'disconnected'
      for (const listener of stateListeners) {
        listener(state)
      }
    })
    expect(serverState).toBe('connected') // Mounted server context deliberately does not transition.
    expect(serverReplica.read().size).toBe(0)
    expect(serverActive.size).toBe(0)
    await advance(4000)
    expect(serverHistory).toHaveLength(beforeContactLoss)
    replay = { ...observation, revision: 40 }
    await act(async () => {
      state = 'connected'
      for (const listener of stateListeners) {
        listener(state)
      }
    })
    await advance(2000)
    expect(serverHistory).toHaveLength(beforeContactLoss + 1)
    expect(serverReplica.read().get('handle')).toEqual(replay)
    expect(serverResults.get(false)?.chat).toBe(false)
    await act(async () => oldContact(frame(101, [])))
    expect(serverReplica.read().get('handle')).toEqual(replay)
    await act(async () => serverHistory.at(-1)!({ type: 'end' }))
    await act(async () => scopedRenderers.shift()?.unmount())
    const oneConsumer = serverHistory.length
    await advance(2000)
    expect(serverHistory).toHaveLength(oneConsumer + 1) // Inactive mounted consumer still owns recovery.
    await act(async () => serverHistory.at(-1)!({ type: 'end' }))
    await act(async () => scopedRenderers.shift()?.unmount())
    const lastReleased = serverHistory.length
    await advance(6000)
    expect(serverHistory).toHaveLength(lastReleased)
    expect(serverActive.size).toBe(0)
    expect(vi.getTimerCount()).toBe(1) // Only the independently retained desktop replica remains.

    // Synchronous opener failure must dispose the logical record after subscribe returns.
    openingFailure = { type: 'error', error: { code: 'remote_runtime_unavailable' } }
    await act(async () => {
      scopedRenderers.push(create(createElement(ServerProbe, { focused: false })))
    })
    expect(serverActive.size).toBe(0)
    const synchronousEnded = serverHistory.at(-1)!
    const syncSubscriptions = serverHistory.length
    await act(async () => client.migrateTo({ ...physical, close: vi.fn() }, 'relay'))
    expect(serverHistory).toHaveLength(syncSubscriptions)
    openingFailure = { type: 'error', error: { code: 'method_not_found' } }
    await advance(2000)
    expect(serverHistory).toHaveLength(syncSubscriptions + 1)
    expect(serverActive.size).toBe(0)
    await advance(20_000)
    expect(serverHistory).toHaveLength(syncSubscriptions + 1) // Unsupported old host is absence, not a retry loop.
    await act(async () => synchronousEnded(frame(100, [observation])))
    expect(serverReplica.read().size).toBe(0)
    await act(async () => scopedRenderers.shift()?.unmount())
    openingFailure = null
    await act(async () => {
      scopedRenderers.push(create(createElement(ServerProbe, { focused: false })))
    })
    expect(serverReplica.read().get('handle')).toEqual(replay) // Fresh consumers can start after final release.
    const beforeClose = serverHistory.at(-1)!
    await act(async () => beforeClose({ type: 'close' }))
    const closeSubscriptions = serverHistory.length
    await act(async () => client.close()) // Close while recovery is pending and consumers remain mounted.
    await advance(6000)
    expect(serverHistory).toHaveLength(closeSubscriptions)
    expect(serverReplica.read().size).toBe(0)
    await act(async () => beforeClose(frame(100, [observation])))
    const disposedReferenceStop = serverReplica.subscribe(() => {})
    await advance(6000)
    disposedReferenceStop()
    expect(serverHistory).toHaveLength(closeSubscriptions)
    expect(serverReplica.read().size).toBe(0)
    expect(active.size).toBe(0)
    expect(stateListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(remaining.read().size).toBe(0)
    expect(physical.sendRequest).not.toHaveBeenCalled()
    stop()
    stopRemounted()
  } finally {
    await act(async () => {
      renderer?.unmount()
      secondRenderer?.unmount()
      scopedRenderers.forEach((screen) => screen.unmount())
    })
    client.close()
    vi.useRealTimers()
  }
})
