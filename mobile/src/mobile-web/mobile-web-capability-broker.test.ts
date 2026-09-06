import { describe, expect, it, vi } from 'vitest'
import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeCancelMessage,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
import { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
const OPAQUE_WORKSPACE_ID = `workspace_0_${'01'.repeat(16)}`

describe('mobile web capability broker', () => {
  it('cancels shell-owned speech when the native app leaves foreground', () => {
    const cancel = vi
      .spyOn(MobileWebSpeechAuthority.prototype, 'cancelForAppBackground')
      .mockImplementation(() => undefined)
    const harness = createHarness()

    harness.broker.updateAppForegroundState(false)
    expect(cancel).toHaveBeenCalledOnce()
    harness.broker.updateAppForegroundState(true)
    expect(cancel).toHaveBeenCalledOnce()

    cancel.mockRestore()
  })

  it('serves a bounded typed workspace snapshot through the explicit host adapter', async () => {
    const harness = createHarness()
    harness.sendRequest.mockResolvedValue({
      ok: true,
      result: {
        worktrees: [
          {
            worktreeId: 'workspace-1',
            displayName: 'One',
            repo: '/repo',
            branch: 'refs/heads/main',
            isActive: true,
            liveTerminalCount: 2
          }
        ]
      }
    })

    await harness.broker.handle(request({ payload: { limit: 10 } }))

    expect(harness.sendRequest).toHaveBeenCalledWith('worktree.ps', { limit: 10_001 })
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'response',
      requestId: 'A'.repeat(22),
      status: 'success',
      payload: {
        workspaces: [
          {
            id: `workspace_0_${'01'.repeat(16)}`,
            name: 'One',
            liveTerminalCount: 2
          }
        ],
        truncated: false,
        nextCursor: null
      }
    })
  })

  it('serves a bounded file index without exposing the host root', async () => {
    const harness = createHarness()
    harness.sendRequest.mockResolvedValue({
      ok: true,
      result: {
        worktree: 'workspace-1',
        rootPath: '/private/worktree',
        files: [{ relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }],
        totalCount: 1,
        truncated: false
      }
    })
    await primeWorkspaceAuthority(harness)

    await harness.broker.handle(
      request({
        capability: 'file',
        operation: 'list',
        payload: { workspaceId: OPAQUE_WORKSPACE_ID, limit: 10 }
      })
    )

    expect(harness.sendRequest).toHaveBeenCalledWith('files.searchPaths', {
      worktree: 'id:workspace-1',
      query: '',
      limit: 10
    })
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'success',
      payload: {
        workspaceId: OPAQUE_WORKSPACE_ID,
        files: [{ relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }]
      }
    })
    expect(JSON.stringify(harness.messages.at(-1))).not.toContain('/private/worktree')
  })

  it('revokes opaque workspace handles when the authenticated Desktop client changes', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    harness.sendRequest.mockClear()
    harness.broker.replaceClient({ sendRequest: vi.fn() } as unknown as RpcClient)

    await harness.broker.handle(
      request({
        capability: 'file',
        operation: 'list',
        payload: { workspaceId: OPAQUE_WORKSPACE_ID, limit: 10 }
      })
    )

    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'not_found' }
    })
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })

  it('cancels pending reads before an old Desktop client can return', async () => {
    const harness = createHarness()
    let resolveHost: ((value: { ok: true; result: unknown }) => void) | undefined
    harness.sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveHost = resolve
      })
    )
    const pending = harness.broker.handle(request())

    harness.broker.replaceClient({ sendRequest: vi.fn() } as unknown as RpcClient)
    await vi.waitFor(() => {
      expect(harness.messages).toHaveLength(1)
    })
    resolveHost?.({ ok: true, result: { worktrees: [] } })
    await pending

    expect(harness.messages[0]).toMatchObject({
      status: 'error',
      error: { code: 'cancelled', retryable: false }
    })
  })

  it('retains recovery routes only for current opaque workspace authority', async () => {
    const harness = createHarness()
    harness.broker.rememberRoute({
      kind: 'session',
      workspaceId: OPAQUE_WORKSPACE_ID,
      workspaceName: 'Feature'
    })
    expect(harness.rememberRoute).not.toHaveBeenCalled()

    await primeWorkspaceAuthority(harness)
    harness.broker.rememberRoute({
      kind: 'session',
      workspaceId: OPAQUE_WORKSPACE_ID,
      workspaceName: 'Feature'
    })
    harness.broker.rememberRoute({ kind: 'workspaceList' })

    expect(harness.rememberRoute).toHaveBeenNthCalledWith(1, {
      kind: 'session',
      workspaceId: OPAQUE_WORKSPACE_ID,
      workspaceName: 'Feature'
    })
    expect(harness.rememberRoute).toHaveBeenNthCalledWith(2, { kind: 'workspaceList' })
    expect(harness.rememberHostRoute).toHaveBeenNthCalledWith(1, {
      kind: 'session',
      hostWorkspaceId: 'workspace-1'
    })
    expect(harness.rememberHostRoute).toHaveBeenNthCalledWith(2, { kind: 'workspaceList' })
  })

  it('grants bounded branch and history reads through the production broker', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    harness.sendRequest.mockImplementation((method) => {
      if (method === 'git.localBranches') {
        return Promise.resolve({
          ok: true,
          result: { current: 'main', branches: ['main', 'feature/mobile'] }
        })
      }
      return Promise.resolve({
        ok: true,
        result: {
          items: [],
          hasIncomingChanges: false,
          hasOutgoingChanges: false,
          hasMore: false,
          limit: 50
        }
      })
    })

    await harness.broker.handle(
      request({
        capability: 'sourceControl',
        operation: 'branches',
        payload: { workspaceId: OPAQUE_WORKSPACE_ID }
      })
    )
    await harness.broker.handle(
      request({
        requestId: 'B'.repeat(22),
        capability: 'sourceControl',
        operation: 'history',
        payload: { workspaceId: OPAQUE_WORKSPACE_ID, limit: 50 }
      })
    )

    expect(harness.sendRequest).toHaveBeenNthCalledWith(2, 'git.localBranches', {
      worktree: 'id:workspace-1'
    })
    expect(harness.sendRequest).toHaveBeenNthCalledWith(3, 'git.history', {
      worktree: 'id:workspace-1',
      limit: 50
    })
    expect(harness.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'success',
          payload: expect.objectContaining({ branches: ['main', 'feature/mobile'] })
        }),
        expect.objectContaining({
          status: 'success',
          payload: expect.objectContaining({ items: [], limit: 50 })
        })
      ])
    )
  })

  it('returns stable errors for invalid payloads, disconnected hosts, and ungranted operations', async () => {
    const harness = createHarness()
    await harness.broker.handle(request({ payload: { limit: 201 } }))
    harness.connected = false
    await harness.broker.handle(request({ requestId: 'B'.repeat(22) }))
    await harness.broker.handle(
      request({
        requestId: 'C'.repeat(22),
        capability: 'task',
        operation: 'get'
      })
    )

    expect(errorCodes(harness.messages)).toEqual([
      'invalid_request',
      'not_connected',
      'unsupported_capability'
    ])
  })

  it('rejects duplicate IDs and requests above an operation rate budget', async () => {
    const harness = createHarness()
    harness.sendRequest.mockResolvedValue({ ok: true, result: { worktrees: [] } })

    await harness.broker.handle(request())
    await harness.broker.handle(request())
    for (let index = 0; index < 4; index += 1) {
      await harness.broker.handle(request({ requestId: idFor(index) }))
    }

    expect(errorCodes(harness.messages)).toContain('invalid_request')
    expect(errorCodes(harness.messages)).toContain('rate_limited')
  })

  it('keeps a long-lived session usable after the bounded request replay window rolls over', async () => {
    const harness = createHarness()

    for (let index = 0; index <= 256; index += 1) {
      await harness.broker.handle(
        request({
          requestId: replayId(index),
          capability: 'task',
          operation: 'get'
        })
      )
    }
    expect(errorCodes(harness.messages)).toHaveLength(257)
    expect(errorCodes(harness.messages).every((code) => code === 'unsupported_capability')).toBe(
      true
    )

    await harness.broker.handle(
      request({
        requestId: replayId(256),
        capability: 'task',
        operation: 'get'
      })
    )
    expect(errorCodes(harness.messages).at(-1)).toBe('invalid_request')
  })

  it('rejects a recently retired subscription ID across new request IDs', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    harness.subscribe.mockReturnValue(vi.fn())

    await harness.broker.handle(subscriptionRequest())
    await harness.broker.handle(subscriptionCancel())
    await harness.broker.handle(subscriptionRequestWithIds('T'.repeat(22), 'S'.repeat(22)))

    expect(harness.subscribe).toHaveBeenCalledOnce()
    expect(errorCodes(harness.messages).at(-1)).toBe('invalid_request')
  })

  it('cancels a pending request and suppresses its late host result', async () => {
    const harness = createHarness()
    let resolveHost: ((value: { ok: true; result: unknown }) => void) | undefined
    harness.sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveHost = resolve
      })
    )
    const pending = harness.broker.handle(request())
    await harness.broker.handle(cancel())
    resolveHost?.({ ok: true, result: { worktrees: [] } })
    await pending

    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]).toMatchObject({
      status: 'error',
      error: { code: 'cancelled', retryable: false }
    })
  })

  it('forwards generated-message cancellation to the originating Desktop client', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    let resolveGeneration: ((value: { ok: true; result: unknown }) => void) | undefined
    harness.sendRequest.mockImplementation((method) => {
      if (method === 'git.status') {
        return Promise.resolve({
          ok: true,
          result: {
            head: 'a'.repeat(40),
            entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
          }
        })
      }
      if (method === 'git.generateCommitMessage') {
        return new Promise((resolve) => {
          resolveGeneration = resolve
        })
      }
      return Promise.resolve({ ok: true, result: { ok: true } })
    })
    const pending = harness.broker.handle(
      request({
        capability: 'sourceControl',
        operation: 'generateCommitMessage',
        payload: {
          workspaceId: OPAQUE_WORKSPACE_ID,
          expectedHead: 'a'.repeat(40),
          stagedEntries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'staged' }]
        }
      })
    )
    await vi.waitFor(() =>
      expect(harness.sendRequest).toHaveBeenCalledWith(
        'git.generateCommitMessage',
        { worktree: 'id:workspace-1' },
        { timeoutMs: 65_000 }
      )
    )

    await harness.broker.handle(cancel())
    expect(harness.sendRequest).toHaveBeenCalledWith('git.cancelGenerateCommitMessage', {
      worktree: 'id:workspace-1'
    })
    resolveGeneration?.({ ok: true, result: { success: true, message: 'late draft' } })
    await pending
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'cancelled' }
    })
  })

  it('suppresses responses after the shell session is disposed', async () => {
    const harness = createHarness()
    let resolveHost: ((value: { ok: true; result: unknown }) => void) | undefined
    harness.sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveHost = resolve
      })
    )
    const pending = harness.broker.handle(request())
    harness.broker.dispose()
    resolveHost?.({ ok: true, result: { worktrees: [] } })
    await pending

    expect(harness.messages).toEqual([])
  })

  it('executes only the named native haptic capability', async () => {
    const harness = createHarness()
    await harness.broker.handle(
      request({
        capability: 'native',
        operation: 'hapticSelection',
        payload: {}
      })
    )

    expect(harness.hapticFeedback).toHaveBeenCalledWith('selection')
    expect(harness.messages.at(-1)).toMatchObject({ status: 'success', payload: null })
  })

  it('streams ordered bounded session snapshots and cleans up explicitly', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    let onData: ((event: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    harness.subscribe.mockImplementation((_method, _params, listener) => {
      onData = listener
      return unsubscribe
    })

    await harness.broker.handle(subscriptionRequest())
    expect(harness.subscribe).toHaveBeenCalledWith(
      'session.tabs.subscribe',
      { worktree: 'id:workspace-1' },
      expect.any(Function)
    )
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'response',
      requestId: 'Q'.repeat(22),
      status: 'success',
      payload: null
    })

    onData?.(sessionEvent(1, 'First'))
    onData?.(sessionEvent(2, 'Second'))
    await vi.waitFor(() => {
      expect(harness.messages.filter((message) => message.type === 'event')).toHaveLength(2)
    })
    const events = harness.messages.filter(
      (message): message is Extract<MobileWebBridgeShellMessage, { type: 'event' }> =>
        message.type === 'event'
    )
    expect(events.map((event) => event.sequence)).toEqual([0, 1])
    expect(events[1]?.payload).toEqual({
      workspaceId: OPAQUE_WORKSPACE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 2,
      workspaceTransportState: 'available',
      activeTabId: null,
      activeTabType: null,
      tabs: [
        { type: 'terminal', id: 'terminal-1', title: 'Second', status: 'ready', isActive: true }
      ],
      truncated: false
    })

    await harness.broker.handle(subscriptionCancel())
    expect(unsubscribe).toHaveBeenCalledOnce()
    onData?.(sessionEvent(3, 'Late'))
    await Promise.resolve()
    expect(harness.messages.filter((message) => message.type === 'event')).toHaveLength(2)
  })

  it('tears down a host subscription cancelled by its synchronous first event', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    const unsubscribe = vi.fn()
    harness.subscribe.mockImplementation((_method, _params, listener) => {
      listener({ type: 'snapshot', worktree: 'different-workspace' })
      return unsubscribe
    })

    await harness.broker.handle(subscriptionRequest())

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'response',
      requestId: 'Q'.repeat(22),
      status: 'success',
      payload: null
    })
    await harness.broker.handle(subscriptionCancel())
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('subscribes to workspace changes without forwarding host file-watch payloads', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    let onData: ((event: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    harness.subscribe.mockImplementation((_method, _params, listener) => {
      onData = listener
      return unsubscribe
    })

    await harness.broker.handle(sourceControlSubscriptionRequest())
    expect(harness.subscribe).toHaveBeenCalledWith(
      'files.watch',
      { worktree: 'id:workspace-1' },
      expect.any(Function)
    )
    onData?.({
      type: 'changed',
      worktree: 'id:workspace-1',
      events: [{ kind: 'update', absolutePath: '/private/repo/src/app.ts' }]
    })
    await vi.waitFor(() => {
      expect(harness.messages.filter((message) => message.type === 'event')).toHaveLength(1)
    })

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'event',
      subscriptionId: 'Y'.repeat(22),
      sequence: 0,
      payload: { workspaceId: OPAQUE_WORKSPACE_ID, reason: 'changed' }
    })
    expect(JSON.stringify(harness.messages)).not.toContain('/private/repo')
    await harness.broker.handle(subscriptionCancel('Y'))
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('routes terminal artifacts through opaque grants and revokes them on connection loss', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    harness.sendRequest.mockImplementation(async (method) => {
      if (method === 'session.tabs.list') {
        return {
          ok: true,
          result: {
            worktree: 'workspace-1',
            activeTabId: 'tab-1',
            tabs: [
              {
                id: 'tab-1',
                type: 'terminal',
                status: 'ready',
                terminal: 'private-terminal-handle',
                isActive: true
              }
            ]
          }
        }
      }
      if (method === 'files.resolveTerminalPath') {
        return {
          ok: true,
          result: {
            worktree: 'workspace-1',
            exists: true,
            isDirectory: false,
            openTarget: {
              kind: 'absolute-file',
              absolutePath: '/private/results/report.txt',
              grantId: 'desktop-grant'
            }
          }
        }
      }
      if (method === 'files.readTerminalArtifactChunk') {
        return {
          ok: true,
          result: { contentBase64: 'T0s=', bytesRead: 2, eof: true }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    await harness.broker.handle(
      request({
        requestId: 'B'.repeat(22),
        capability: 'file',
        operation: 'resolveTerminalPath',
        payload: {
          workspaceId: OPAQUE_WORKSPACE_ID,
          tabId: 'tab-1',
          pathText: '/private/results/report.txt',
          line: null,
          column: null
        }
      })
    )
    const resolved = successPayload(harness.messages.at(-1))
    expect(resolved).toMatchObject({
      kind: 'terminal-artifact',
      workspaceId: OPAQUE_WORKSPACE_ID,
      displayName: 'report.txt',
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
    })
    expect(JSON.stringify(resolved)).not.toContain('/private')
    const token = isRecord(resolved) && typeof resolved.token === 'string' ? resolved.token : ''

    await harness.broker.handle(
      request({
        requestId: 'C'.repeat(22),
        capability: 'file',
        operation: 'readTerminalArtifactChunk',
        payload: {
          workspaceId: OPAQUE_WORKSPACE_ID,
          tabId: 'tab-1',
          token,
          offset: 0,
          length: 2
        }
      })
    )
    expect(successPayload(harness.messages.at(-1))).toMatchObject({
      token,
      contentBase64: 'T0s=',
      bytesRead: 2,
      eof: true
    })

    harness.broker.updateConnectionState('offline')
    await harness.broker.handle(
      request({
        requestId: 'D'.repeat(22),
        capability: 'file',
        operation: 'readTerminalArtifactChunk',
        payload: {
          workspaceId: OPAQUE_WORKSPACE_ID,
          tabId: 'tab-1',
          token,
          offset: 0,
          length: 2
        }
      })
    )
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'not_found' }
    })
    expect(
      harness.sendRequest.mock.calls.filter(
        ([method]) => method === 'files.readTerminalArtifactChunk'
      )
    ).toHaveLength(1)
  })
})

function createHarness() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>()
  const hapticFeedback = vi.fn()
  const rememberRoute = vi.fn()
  const rememberHostRoute = vi.fn()
  const state = { active: true, connected: true }
  let nonce = 0
  const client = { sendRequest, subscribe } as unknown as RpcClient
  const { broker, messages } = createMobileWebBrokerFixture({
    getClient: () => client,
    isConnected: () => state.connected,
    isActive: () => state.active,
    nativeAuthority: { hapticFeedback },
    rememberRoute,
    rememberHostRoute,
    randomBytes: (length) => new Uint8Array(length).fill(++nonce),
    now: () => 1000
  })
  return {
    broker,
    messages,
    sendRequest,
    subscribe,
    hapticFeedback,
    rememberRoute,
    rememberHostRoute,
    get connected() {
      return state.connected
    },
    set connected(value: boolean) {
      state.connected = value
    }
  }
}

function subscriptionRequest(): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return subscriptionRequestWithIds('Q'.repeat(22), 'S'.repeat(22))
}

function subscriptionRequestWithIds(
  requestId: string,
  subscriptionId: string
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return mobileWebBridgeRequestMessage({
    requestId,
    subscriptionId,
    capability: 'session',
    operation: 'subscribe',
    payload: { workspaceId: OPAQUE_WORKSPACE_ID }
  })
}

async function primeWorkspaceAuthority(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.sendRequest.mockResolvedValueOnce({
    ok: true,
    result: {
      worktrees: [{ worktreeId: 'workspace-1', repoId: 'repo-1' }]
    }
  })
  await harness.broker.handle(request({ requestId: 'P'.repeat(22), payload: { limit: 1 } }))
}

function subscriptionCancel(id = 'S'): Extract<MobileWebBridgePageMessage, { type: 'cancel' }> {
  return mobileWebBridgeCancelMessage({ target: 'subscription', id: id.repeat(22) })
}

function sourceControlSubscriptionRequest(): Extract<
  MobileWebBridgePageMessage,
  { type: 'request' }
> {
  return mobileWebBridgeRequestMessage({
    requestId: 'X'.repeat(22),
    subscriptionId: 'Y'.repeat(22),
    capability: 'sourceControl',
    operation: 'subscribe',
    payload: { workspaceId: OPAQUE_WORKSPACE_ID }
  })
}

function sessionEvent(snapshotVersion: number, title: string) {
  return {
    type: snapshotVersion === 1 ? 'snapshot' : 'updated',
    worktree: 'workspace-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'terminal',
        id: 'terminal-1',
        title,
        status: 'ready',
        terminal: 'secret-terminal-handle',
        isActive: true
      }
    ]
  }
}

function request(
  overrides: Partial<Extract<MobileWebBridgePageMessage, { type: 'request' }>> = {}
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    ...mobileWebBridgeRequestMessage({
      requestId: 'A'.repeat(22),
      capability: 'workspace',
      operation: 'snapshot',
      payload: {}
    }),
    ...overrides
  } as Extract<MobileWebBridgePageMessage, { type: 'request' }>
}

function successPayload(message: MobileWebBridgeShellMessage | undefined): unknown {
  if (message?.type !== 'response' || message.status !== 'success') {
    throw new Error('Expected a successful bridge response')
  }
  return message.payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cancel(): Extract<MobileWebBridgePageMessage, { type: 'cancel' }> {
  return mobileWebBridgeCancelMessage({ target: 'request', id: 'A'.repeat(22) })
}

function idFor(index: number): string {
  return String.fromCharCode('D'.charCodeAt(0) + index).repeat(22)
}

function replayId(index: number): string {
  return index.toString(36).padStart(22, '0')
}

function errorCodes(messages: MobileWebBridgeShellMessage[]): string[] {
  return messages.flatMap((message) =>
    message.type === 'response' && message.status === 'error' ? [message.error.code] : []
  )
}
