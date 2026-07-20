import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserUseConnection } from './browser-use-cdp-connection'
import type { CdpWsProxy } from './cdp-ws-proxy'
import type { CodexBrowserUseCdpTarget, RpcNotificationEmitter } from './codex-browser-use-protocol'
import { OrcaCodexBrowserUseAdapter } from './orca-codex-browser-use-adapter'

function status(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    agentType: 'codex',
    connectionId: null,
    paneKey: 'tab:pane',
    prompt: '',
    providerSession: { key: 'session_id', id: 'codex-session' },
    receivedAt: 1,
    state: 'working',
    stateStartedAt: 1,
    worktreeId: 'worktree-1',
    ...overrides
  } as AgentStatusIpcPayload
}

function adapter(
  statuses: AgentStatusIpcPayload[],
  livePaneKeys = new Set(statuses.map(({ paneKey }) => paneKey))
): OrcaCodexBrowserUseAdapter {
  return new OrcaCodexBrowserUseAdapter(
    { onCodexBrowserUseProcessSwap: () => () => undefined } as unknown as AgentBrowserBridge,
    () => statuses,
    (paneKey) => livePaneKeys.has(paneKey)
  )
}

describe('OrcaCodexBrowserUseAdapter session resolution', () => {
  it('resolves an exact live local Codex session to one worktree', () => {
    expect(adapter([status()]).resolveWorktreeId('codex-session')).toBe('worktree-1')
  })

  it('rejects remote, stale, non-Codex, and mismatched provider sessions', () => {
    const statuses = [
      status({ connectionId: 'ssh-1', paneKey: 'remote' }),
      status({ paneKey: 'stale' }),
      status({ agentType: 'claude', paneKey: 'claude' }),
      status({ paneKey: 'other', providerSession: { key: 'session_id', id: 'other-session' } })
    ]
    expect(
      adapter(statuses, new Set(['remote', 'claude', 'other'])).resolveWorktreeId('codex-session')
    ).toBeNull()
  })

  it('rejects an ambiguous session mapped to more than one live worktree', () => {
    const statuses = [status(), status({ paneKey: 'tab:other', worktreeId: 'worktree-2' })]
    expect(adapter(statuses).resolveWorktreeId('codex-session')).toBeNull()
  })
})

type FakeConnection = {
  execute: BrowserUseConnection['execute']
  attachTarget: BrowserUseConnection['attachTarget']
  detachTarget: BrowserUseConnection['detachTarget']
  close: BrowserUseConnection['close']
  triggerClose: () => void
}

function connectionAdapter(
  options: { waitForFirstConnection?: Promise<void>; holdFirstExecute?: boolean } = {}
) {
  const proxies: CdpWsProxy[] = []
  const connections: FakeConnection[] = []
  let rejectFirstExecute: ((error: Error) => void) | null = null
  let processSwapListener: ((browserPageId: string) => void) | null = null
  const bridge = {
    onCodexBrowserUseProcessSwap: vi.fn((listener: (browserPageId: string) => void) => {
      processSwapListener = listener
      return () => {
        processSwapListener = null
      }
    }),
    createCodexBrowserUseCdpProxy: vi.fn(() => {
      const proxy = { sequence: proxies.length + 1 } as unknown as CdpWsProxy
      proxies.push(proxy)
      return proxy
    }),
    navigateCodexBrowserUseTab: vi.fn(async () => ({ frameId: 'orca-proxy-target' }))
  } as unknown as AgentBrowserBridge
  const createConnection = vi.fn(
    async (
      _proxy: CdpWsProxy,
      _tabId: number,
      _emit: RpcNotificationEmitter,
      onClose: () => void
    ) => {
      if (connections.length === 0) {
        await options.waitForFirstConnection
      }
      const sequence = connections.length + 1
      const connection: FakeConnection = {
        execute: vi.fn(async (_target: CodexBrowserUseCdpTarget, method: string) => {
          if (sequence === 1 && options.holdFirstExecute) {
            return await new Promise<never>((_resolve, reject) => {
              rejectFirstExecute = reject
            })
          }
          return `connection-${sequence}:${method}`
        }),
        attachTarget: vi.fn(async () => undefined),
        detachTarget: vi.fn(async () => undefined),
        close: vi.fn(async () => {
          rejectFirstExecute?.(new Error('Browser CDP connection closed'))
          rejectFirstExecute = null
        }),
        triggerClose: onClose
      }
      connections.push(connection)
      return connection
    }
  )
  return {
    adapter: new OrcaCodexBrowserUseAdapter(
      bridge,
      () => [],
      () => false,
      createConnection
    ),
    bridge,
    connections,
    createConnection,
    emitProcessSwap: (browserPageId: string) => processSwapListener?.(browserPageId)
  }
}

const noNotification: RpcNotificationEmitter = () => undefined
const cdpTarget: CodexBrowserUseCdpTarget = { tabId: 1 }

describe('OrcaCodexBrowserUseAdapter connection lifecycle', () => {
  it('recreates the CDP proxy lazily after the current renderer connection closes', async () => {
    const harness = connectionAdapter()
    await harness.adapter.attach('owner-1', 'session-1', 'worktree-1', 'page-1', 1, noNotification)

    harness.emitProcessSwap('page-1')
    await expect(
      harness.adapter.executeCdp(
        'owner-1',
        'session-1',
        'worktree-1',
        'page-1',
        cdpTarget,
        'Runtime.evaluate',
        {}
      )
    ).resolves.toBe('connection-2:Runtime.evaluate')

    expect(harness.bridge.createCodexBrowserUseCdpProxy).toHaveBeenCalledTimes(2)
    expect(harness.bridge.createCodexBrowserUseCdpProxy).toHaveBeenNthCalledWith(
      2,
      'worktree-1',
      'page-1'
    )
  })

  it('retries an in-flight CDP command on the replacement renderer connection', async () => {
    const harness = connectionAdapter({ holdFirstExecute: true })
    await harness.adapter.attach('owner-1', 'session-1', 'worktree-1', 'page-1', 1, noNotification)
    const command = harness.adapter.executeCdp(
      'owner-1',
      'session-1',
      'worktree-1',
      'page-1',
      cdpTarget,
      'Runtime.evaluate',
      { expression: 'location.href' }
    )
    await vi.waitFor(() => expect(harness.connections[0].execute).toHaveBeenCalledOnce())

    harness.emitProcessSwap('page-1')

    await expect(command).resolves.toBe('connection-2:Runtime.evaluate')
    expect(harness.connections[0].close).toHaveBeenCalledOnce()
    expect(harness.bridge.createCodexBrowserUseCdpProxy).toHaveBeenCalledTimes(2)
  })

  it('uses the current Electron tab for top-level navigation', async () => {
    const harness = connectionAdapter()
    await harness.adapter.attach('owner-1', 'session-1', 'worktree-1', 'page-1', 1, noNotification)

    await expect(
      harness.adapter.executeCdp(
        'owner-1',
        'session-1',
        'worktree-1',
        'page-1',
        cdpTarget,
        'Page.navigate',
        { url: 'https://example.org/', frameId: 'playwright-main-frame' }
      )
    ).resolves.toEqual({ frameId: 'orca-proxy-target' })

    expect(harness.bridge.navigateCodexBrowserUseTab).toHaveBeenCalledWith(
      'worktree-1',
      'page-1',
      'https://example.org/'
    )
    expect(harness.connections[0].execute).not.toHaveBeenCalled()
  })

  it('rejects CDP commands from a native connection that no longer owns the tab', async () => {
    const harness = connectionAdapter()
    await harness.adapter.attach('owner-1', 'session-1', 'worktree-1', 'page-1', 1, noNotification)
    await harness.adapter.attach('owner-2', 'session-1', 'worktree-1', 'page-1', 1, noNotification)

    await expect(
      harness.adapter.executeCdp(
        'owner-1',
        'session-1',
        'worktree-1',
        'page-1',
        cdpTarget,
        'Runtime.evaluate',
        {}
      )
    ).rejects.toThrow('not owned')
    await expect(
      harness.adapter.executeCdp(
        'owner-2',
        'session-1',
        'worktree-1',
        'page-1',
        cdpTarget,
        'Runtime.evaluate',
        {}
      )
    ).resolves.toBe('connection-2:Runtime.evaluate')
    expect(harness.connections[0].close).toHaveBeenCalledOnce()
  })

  it('serializes overlapping owners so only the last attachment remains active', async () => {
    let releaseFirst!: () => void
    const firstConnectionGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const harness = connectionAdapter({ waitForFirstConnection: firstConnectionGate })
    const first = harness.adapter.attach(
      'owner-1',
      'session-1',
      'worktree-1',
      'page-1',
      1,
      noNotification
    )
    await vi.waitFor(() => expect(harness.createConnection).toHaveBeenCalledTimes(1))
    const second = harness.adapter.attach(
      'owner-2',
      'session-1',
      'worktree-1',
      'page-1',
      1,
      noNotification
    )

    releaseFirst()
    await Promise.all([first, second])

    expect(harness.createConnection).toHaveBeenCalledTimes(2)
    expect(harness.connections[0].close).toHaveBeenCalledOnce()
    await expect(
      harness.adapter.executeCdp(
        'owner-1',
        'session-1',
        'worktree-1',
        'page-1',
        cdpTarget,
        'Runtime.evaluate',
        {}
      )
    ).rejects.toThrow('not owned')
    await expect(
      harness.adapter.executeCdp(
        'owner-2',
        'session-1',
        'worktree-1',
        'page-1',
        cdpTarget,
        'Runtime.evaluate',
        {}
      )
    ).resolves.toBe('connection-2:Runtime.evaluate')
  })
})
