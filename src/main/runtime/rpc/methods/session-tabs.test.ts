import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab RPC methods', () => {
  it('routes mobile-only activation without notifying desktop clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      activateMobileSessionTab: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        tabs: []
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.activate', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        notifyClients: false
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.activateMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', 'leaf-1', {
      notifyClients: false,
      clientNavigationId: undefined,
      navigation: 'caller'
    })
  })

  it('defaults legacy paired activation to the authenticated caller identity', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      activateMobileSessionTab: vi.fn().mockResolvedValue({ tabs: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.activate', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        notifyClients: true
      }),
      (response) => replies.push(response),
      { clientKind: 'runtime', pairedDeviceId: 'device-a' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.activateMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', undefined, {
      notifyClients: true,
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })
  })

  it('refuses a reasonless close without invoking destructive runtime logic', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn().mockResolvedValue({
        closed: true,
        refused: true,
        snapshotRepublished: true
      }),
      closeMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { closed: true, refused: true, snapshotRepublished: true }
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).toHaveBeenCalledWith('id:wt-1', 'tab-1')
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })

  it('passes explicit user intent to host adjudication', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        reason: 'user'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('preserves reasonless explicit closes from authenticated legacy mobile clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      { clientKind: 'mobile' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('preserves reasonless explicit closes from authenticated legacy runtime clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      { clientKind: 'runtime', pairedDeviceId: 'legacy-runtime' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it.each(['pty-exit', 'cleanup'] as const)(
    'rejects %s on the legacy close endpoint before host adjudication',
    async (reason) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        closeMobileSessionTab: vi.fn()
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('session.tabs.close', {
          worktree: 'id:wt-1',
          tabId: 'tab-1',
          reason
        })
      )

      expect(response.ok).toBe(false)
      expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
    }
  )

  it.each(['pty-exit', 'cleanup'] as const)(
    'binds a %s lifecycle close to the observed publication and terminal',
    async (reason) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('session.tabs.closeLifecycle', {
          worktree: 'id:wt-1',
          tabId: 'tab-1',
          reason,
          publicationEpoch: 'epoch-1',
          terminal: 'term-1'
        })
      )

      expect(response.ok).toBe(true)
      expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
        reason,
        expectedPublicationEpoch: 'epoch-1',
        expectedTerminalHandle: 'term-1'
      })
    }
  )

  it('dispatches tab moves through the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn().mockResolvedValue({
        moved: true
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1::leaf-1',
        targetGroupId: 'group-left',
        kind: 'reorder',
        tabOrder: ['tab-2::leaf-1', 'tab-1::leaf-1']
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
      tabId: 'tab-1::leaf-1',
      targetGroupId: 'group-left',
      kind: 'reorder',
      tabOrder: ['tab-2::leaf-1', 'tab-1::leaf-1']
    })
  })

  it('rejects ambiguous tab move payloads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-1',
        kind: 'reorder',
        splitDirection: 'right',
        tabOrder: ['tab-1']
      })
    )

    expect(response.ok).toBe(false)
    expect(runtime.moveMobileSessionTab).not.toHaveBeenCalled()
  })

  it('dispatches split tab moves without reorder-only fields', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn().mockResolvedValue({ moved: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-2',
        kind: 'split',
        splitDirection: 'right'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
      tabId: 'tab-1',
      targetGroupId: 'group-2',
      kind: 'split',
      splitDirection: 'right'
    })
  })

  it('dispatches ordinary terminal creation with the requested tab group', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        targetGroupId: 'group-left',
        command: 'zsh',
        cwd: '/repo/packages/app',
        env: { CODEX_PROFILE: 'captured' },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        launchToken: 'launch-token-123',
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        viewMode: 'chat',
        activate: true
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith('id:wt-1', {
      afterTabId: undefined,
      targetGroupId: 'group-left',
      command: 'zsh',
      cwd: '/repo/packages/app',
      env: { CODEX_PROFILE: 'captured' },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      startupCommandDelivery: undefined,
      agent: undefined,
      launchToken: 'launch-token-123',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchAgent: 'codex',
      viewMode: 'chat',
      activate: true,
      select: undefined,
      clientNavigationId: undefined,
      navigation: 'all',
      clientMutationId: undefined,
      signal: undefined
    })
  })

  it('defaults legacy paired terminal creation to caller-owned selection', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: { type: 'terminal', id: 'tab-1::leaf-1' },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        activate: true,
        clientMutationId: 'create-1'
      }),
      () => {},
      { clientKind: 'runtime', pairedDeviceId: 'device-a' }
    )

    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        activate: true,
        clientMutationId: 'create-1',
        clientNavigationId: 'device-a',
        navigation: 'caller'
      })
    )
  })

  it('preserves legacy agent creation for mixed-version clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agent: 'codex',
        agentPrompt: 'Review this diff'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith('id:wt-1', {
      afterTabId: undefined,
      targetGroupId: undefined,
      command: undefined,
      cwd: undefined,
      startupCommandDelivery: undefined,
      agent: 'codex',
      agentPrompt: 'Review this diff',
      activate: undefined,
      select: undefined,
      clientNavigationId: undefined,
      navigation: 'all',
      clientMutationId: undefined,
      signal: undefined
    })
  })

  it('rejects agent prompts without an agent preset', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agentPrompt: 'Review this diff'
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Agent prompt requires an agent preset' }
    })
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('dispatches terminal creation with startup command delivery metadata', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        command: "codex 'linked issue context'",
        startupCommandDelivery: 'shell-ready'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith('id:wt-1', {
      afterTabId: undefined,
      targetGroupId: undefined,
      command: "codex 'linked issue context'",
      startupCommandDelivery: 'shell-ready',
      agent: undefined,
      activate: undefined,
      select: undefined,
      clientNavigationId: undefined,
      navigation: 'all'
    })
  })

  it('rejects unknown agent presets without creating a terminal', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agent: 'not-real'
      })
    )

    expect(response.ok).toBe(false)
    expect(response).toMatchObject({
      error: { code: 'invalid_argument', message: 'Unknown agent preset' }
    })
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('streams all known session tab snapshots and later updates', async () => {
    const unsubscribe = vi.fn()
    const listeners: ((snapshot: unknown) => void)[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAllMobileSessionTabs: vi.fn(() => [
        {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        {
          worktree: 'wt-2',
          publicationEpoch: 'epoch-2',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]),
      onMobileSessionTabsChanged: vi.fn((listener: (snapshot: unknown) => void) => {
        listeners.push(listener)
        return unsubscribe
      }),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )
    listeners[0]?.({
      worktree: 'wt-1',
      publicationEpoch: 'epoch-3',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*:req-1',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.onMobileSessionTabsChanged).toHaveBeenCalledTimes(1)
    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      {
        type: 'snapshots',
        snapshots: [
          expect.objectContaining({ worktree: 'wt-1' }),
          expect.objectContaining({ worktree: 'wt-2' })
        ]
      },
      expect.objectContaining({ type: 'updated', worktree: 'wt-1', snapshotVersion: 2 })
    ])
  })

  it('keeps duplicate all-session-tab subscribers independent on one connection', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAllMobileSessionTabs: vi.fn(() => []),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribeAll'), id: 'sub-all-1' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )
    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribeAll'), id: 'sub-all-2' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*:sub-all-1',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*:sub-all-2',
      expect.any(Function),
      'conn-1'
    )
  })

  it('registers session tab subscription cleanup with the resolved worktree id', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribe', { worktree: 'id:wt-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:wt-1:req-1',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.registerSubscriptionCleanup).not.toHaveBeenCalledWith(
      'session.tabs:conn-1:id:wt-1',
      expect.any(Function),
      'conn-1'
    )
  })

  it('keeps duplicate session tab subscribers for one worktree independent', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribe', { worktree: 'id:wt-1' }), id: 'sub-1' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )
    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribe', { worktree: 'wt-1' }), id: 'sub-2' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:wt-1:sub-1',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:wt-1:sub-2',
      expect.any(Function),
      'conn-1'
    )
  })

  it('unsubscribes a session tabs stream using the resolved worktree id and connection id', async () => {
    const cleanupSubscription = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      cleanupSubscription,
      cleanupSubscriptionsByPrefix: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.unsubscribe', { worktree: 'id:wt-1' }),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:wt-1')
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: true,
      result: { unsubscribed: true }
    })
  })

  it('unsubscribes one shared-control session tab stream by subscription id', async () => {
    const cleanupSubscription = vi.fn()
    const cleanupSubscriptionsByPrefix = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      cleanupSubscription,
      cleanupSubscriptionsByPrefix
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.unsubscribe', { worktree: 'id:wt-1', subscriptionId: 'sub-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:wt-1:sub-1')
    expect(cleanupSubscriptionsByPrefix).not.toHaveBeenCalled()
  })

  it('unsubscribes one shared-control all-session-tabs stream by subscription id', async () => {
    const cleanupSubscription = vi.fn()
    const cleanupSubscriptionsByPrefix = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscription,
      cleanupSubscriptionsByPrefix
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.unsubscribeAll', { subscriptionId: 'sub-all-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:*:sub-all-1')
    expect(cleanupSubscriptionsByPrefix).not.toHaveBeenCalled()
  })
})
