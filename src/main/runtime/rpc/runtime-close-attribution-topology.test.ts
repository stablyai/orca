import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../../observability/tracer'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { SESSION_TAB_METHODS } from './methods/session-tabs'
import { TERMINAL_METHODS } from './methods/terminal'

const BEARER_CLIENT_ID = 'secret-bearer-client-id'

type SpanRecord = {
  name: string
  attributes: Record<string, unknown>
  exit: { _tag: string }
}

function request(id: string, method: string, params: unknown): RpcRequest {
  return { id, authToken: 'test-token', method, params }
}

function visibleSessionTab(worktree: string, tabId: string) {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tabId,
    activeTabType: 'browser' as const,
    tabs: [
      {
        type: 'browser' as const,
        id: tabId,
        title: 'Browser',
        browserWorkspaceId: tabId,
        browserPageId: tabId,
        url: 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: true
      }
    ]
  }
}

describe('runtime close attribution topology', () => {
  const records: SpanRecord[] = []

  beforeEach(() => {
    records.length = 0
    setActiveSink({
      push: (record) => records.push(record as SpanRecord),
      flush: vi.fn(),
      close: vi.fn()
    } satisfies TracerSink)
  })

  afterEach(() => _resetTracerForTests())

  it('identifies the authoritative runtime and target for remote, stale, and legacy closes', async () => {
    const closeMobileSessionTab = vi
      .fn()
      .mockResolvedValueOnce({ closed: true, refused: true, refusalReason: 'stale-terminal' })
      .mockResolvedValue({ closed: true })
    const runtime = {
      getRuntimeId: () => 'runtime-owner-1',
      closeMobileSessionTab,
      listMobileSessionTabs: vi.fn(async (worktree: string) =>
        visibleSessionTab(worktree, worktree.endsWith('a') ? 'tab-a' : 'tab-b')
      ),
      refuseUnattributedMobileSessionTabClose: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      request('stale-1', 'session.tabs.closeLifecycle', {
        worktree: 'id:worktree-a',
        tabId: 'tab-a',
        reason: 'cleanup',
        publicationEpoch: 'epoch-old',
        terminal: 'terminal-old'
      }),
      vi.fn(),
      {
        clientId: BEARER_CLIENT_ID,
        pairedDeviceId: 'device-1',
        connectionId: 'connection-before-reconnect',
        clientKind: 'runtime'
      }
    )
    await dispatcher.dispatchStreaming(
      request('legacy-1', 'session.tabs.close', {
        worktree: 'id:worktree-b',
        tabId: 'tab-b'
      }),
      vi.fn(),
      {
        clientId: BEARER_CLIENT_ID,
        pairedDeviceId: 'device-1',
        connectionId: 'connection-after-reconnect',
        clientKind: 'runtime',
        clientCapabilities: []
      }
    )

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      name: 'runtime.session-tabs.close-lifecycle',
      attributes: {
        runtimeId: 'runtime-owner-1',
        worktree: 'id:worktree-a',
        tabId: 'tab-a',
        terminal: 'terminal-old',
        deviceId: 'device-1',
        connectionGeneration: 'connection-before-reconnect',
        requestId: 'stale-1',
        decision: 'refused-stale-terminal'
      },
      exit: { _tag: 'Success' }
    })
    expect(records[1]).toMatchObject({
      name: 'runtime.session-tabs.close',
      attributes: {
        runtimeId: 'runtime-owner-1',
        worktree: 'id:worktree-b',
        tabId: 'tab-b',
        deviceId: 'device-1',
        connectionGeneration: 'connection-after-reconnect',
        requestId: 'legacy-1',
        closeReason: 'legacy-runtime-user',
        decision: 'allowed'
      }
    })
    expect(JSON.stringify(records)).not.toContain(BEARER_CLIENT_ID)
  })

  it('keeps concurrent cross-worktree request and target identities distinct', async () => {
    const closeMobileSessionTab = vi.fn().mockResolvedValue({ closed: true })
    const runtime = {
      getRuntimeId: () => 'runtime-owner-2',
      listMobileSessionTabs: vi.fn(async (worktree: string) =>
        visibleSessionTab(worktree, worktree.endsWith('a') ? 'tab-a' : 'tab-b')
      ),
      closeMobileSessionTab
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await Promise.all(
      (
        [
          ['request-a', 'device-a', 'connection-a', 'worktree-a', 'tab-a'],
          ['request-b', 'device-b', 'connection-b', 'worktree-b', 'tab-b']
        ] as const
      ).map(([id, deviceId, connectionId, worktree, tabId]) =>
        dispatcher.dispatchStreaming(
          request(id, 'session.tabs.close', {
            worktree: `id:${worktree}`,
            tabId,
            reason: 'user'
          }),
          vi.fn(),
          { clientKind: 'runtime', pairedDeviceId: deviceId, connectionId }
        )
      )
    )

    expect(records.map((record) => record.attributes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: 'runtime-owner-2',
          worktree: 'id:worktree-a',
          tabId: 'tab-a',
          deviceId: 'device-a',
          connectionGeneration: 'connection-a',
          requestId: 'request-a'
        }),
        expect.objectContaining({
          runtimeId: 'runtime-owner-2',
          worktree: 'id:worktree-b',
          tabId: 'tab-b',
          deviceId: 'device-b',
          connectionGeneration: 'connection-b',
          requestId: 'request-b'
        })
      ])
    )
    expect(closeMobileSessionTab).toHaveBeenCalledTimes(2)
  })

  it('records resolved terminal outcome and failed unowned requests without extra inventory', async () => {
    const closeTerminal = vi
      .fn()
      .mockResolvedValueOnce({ handle: 'terminal-live', tabId: 'tab-live', ptyKilled: true })
      .mockRejectedValueOnce(new Error('terminal_handle_stale'))
    const listSessions = vi.fn()
    const runtime = {
      getRuntimeId: () => 'runtime-owner-3',
      closeTerminal,
      listSessions
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const context = {
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-terminal',
      connectionId: 'connection-terminal'
    }

    await dispatcher.dispatchStreaming(
      request('terminal-live-request', 'terminal.close', { terminal: 'terminal-live' }),
      vi.fn(),
      context
    )
    await dispatcher.dispatchStreaming(
      request('terminal-stale-request', 'terminal.close', { terminal: 'terminal-stale' }),
      vi.fn(),
      context
    )

    expect(records[0]).toMatchObject({
      attributes: {
        runtimeId: 'runtime-owner-3',
        terminal: 'terminal-live',
        tabId: 'tab-live',
        ptyKilled: true,
        decision: 'allowed',
        outcome: 'succeeded'
      },
      exit: { _tag: 'Success' }
    })
    expect(records[1]).toMatchObject({
      attributes: {
        runtimeId: 'runtime-owner-3',
        terminal: 'terminal-stale',
        decision: 'allowed',
        outcome: 'failed'
      },
      exit: { _tag: 'Failure' }
    })
    expect(closeTerminal).toHaveBeenCalledTimes(2)
    expect(listSessions).not.toHaveBeenCalled()
  })
})
