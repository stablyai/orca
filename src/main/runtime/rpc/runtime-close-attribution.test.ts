import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../../observability/tracer'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { SESSION_TAB_METHODS } from './methods/session-tabs'
import { TERMINAL_METHODS } from './methods/terminal'

const BEARER_CLIENT_ID = 'secret-bearer-client-id'

type CapturingSink = TracerSink & { records: unknown[] }

function capturingSink(): CapturingSink {
  const records: unknown[] = []
  return {
    records,
    push: (record) => records.push(record),
    flush: vi.fn(),
    close: vi.fn()
  }
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'close-request-1', authToken: 'test-token', method, params }
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

describe('runtime close attribution', () => {
  let sink: CapturingSink

  beforeEach(() => {
    sink = capturingSink()
    setActiveSink(sink)
  })

  afterEach(() => {
    _resetTracerForTests()
  })

  it.each([
    ['terminal.close', 'closeTerminal', 'terminal'],
    ['terminal.closeTab', 'closeTerminalTab', 'terminal-tab']
  ] as const)(
    'records %s with the device identity and without the bearer credential',
    async (method, call, targetKind) => {
      const close = vi.fn().mockResolvedValue({ handle: 'term-1', ptyKilled: true })
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        [call]: close
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const replies: string[] = []

      await dispatcher.dispatchStreaming(
        request(method, { terminal: 'term-1' }),
        (reply) => replies.push(reply),
        {
          clientId: BEARER_CLIENT_ID,
          pairedDeviceId: 'device-uuid-123',
          connectionId: 'connection-7',
          clientKind: 'runtime'
        }
      )

      expect(JSON.parse(replies[0]!)).toMatchObject({ ok: true })
      expect(close).toHaveBeenCalledWith('term-1')
      expect(sink.records).toEqual([
        expect.objectContaining({
          type: 'effect-span',
          name: method,
          attributes: expect.objectContaining({
            attribution: 'terminal-close',
            origin: 'runtime',
            deviceId: 'device-uuid-123',
            connectionGeneration: 'connection-7',
            requestId: 'close-request-1',
            targetKind,
            terminal: 'term-1',
            decision: 'allowed'
          }),
          exit: { _tag: 'Success' }
        })
      ])
      expect(JSON.stringify(sink.records)).not.toContain(BEARER_CLIENT_ID)
    }
  )

  it.each([
    [
      'session.tabs.close',
      { worktree: 'id:wt-1', tabId: 'tab-1', reason: 'user' },
      'runtime.session-tabs.close'
    ],
    [
      'session.tabs.closeLifecycle',
      {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminal: 'term-1'
      },
      'runtime.session-tabs.close-lifecycle'
    ]
  ] as const)(
    'records the device identity for %s without the bearer credential',
    async (method, params, spanName) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        listMobileSessionTabs: vi.fn(async () => visibleSessionTab('wt-1', 'tab-1')),
        closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      await dispatcher.dispatchStreaming(request(method, params), vi.fn(), {
        clientId: BEARER_CLIENT_ID,
        pairedDeviceId: 'device-uuid-123',
        connectionId: 'connection-7',
        clientKind: 'runtime'
      })

      expect(sink.records).toEqual([
        expect.objectContaining({
          name: spanName,
          attributes: expect.objectContaining({ deviceId: 'device-uuid-123' })
        })
      ])
      expect(JSON.stringify(sink.records)).not.toContain(BEARER_CLIENT_ID)
    }
  )
})
