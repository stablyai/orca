import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { nativeHostSessionTabOperations } from './native-host-session-tab-operations'

describe('native host session tab operations', () => {
  it('projects status into the reviewed Session feature gates', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: {
        capabilities: [
          'browser.screencast.v1',
          'aiVault.v1',
          'terminal.quick-commands.v1',
          'terminal.query-reply-input.v1',
          'secret.unreviewed.v1'
        ]
      }
    })
    const operations = nativeHostSessionTabOperations({
      sendRequest
    } as unknown as RpcClient)

    await expect(operations.runtimeCapabilities()).resolves.toEqual({
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: true,
      terminalQueryReplyInputSupported: true
    })
    expect(sendRequest).toHaveBeenCalledWith('status.get')
  })

  it('maps named lifecycle operations to the existing caller-local RPCs', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({ ok: true, result: sessionSnapshot(1) })
      .mockResolvedValueOnce({ ok: true, result: { created: true } })
      .mockResolvedValueOnce({ ok: true, result: sessionSnapshot(2) })
      .mockResolvedValueOnce({ ok: true, result: { browserPageId: 'browser-1' } })
      .mockResolvedValueOnce({ ok: true, result: sessionSnapshot(3) })
      .mockResolvedValueOnce({ ok: true, result: { closed: true } })
    const operations = nativeHostSessionTabOperations({
      sendRequest
    } as unknown as RpcClient)

    await expect(operations.snapshot('workspace-1')).resolves.toEqual(sessionSnapshot(1))
    await expect(operations.createBlank('workspace-1')).resolves.toEqual(sessionSnapshot(2))
    await expect(operations.createBrowser('workspace-1', 'https://example.com')).resolves.toEqual({
      browserPageId: 'browser-1'
    })
    await expect(operations.activate('workspace-1', 'tab-1', 'leaf-1')).resolves.toEqual(
      sessionSnapshot(3)
    )
    await expect(operations.close('workspace-1', 'tab-1')).resolves.toEqual({
      outcome: 'closed'
    })

    expect(sendRequest.mock.calls).toEqual([
      ['session.tabs.list', { worktree: 'id:workspace-1' }],
      [
        'session.tabs.createTerminal',
        {
          worktree: 'id:workspace-1',
          clientMutationId: expect.stringMatching(/^mobile-create:/),
          activate: false,
          select: true,
          navigation: 'caller'
        }
      ],
      ['session.tabs.list', { worktree: 'id:workspace-1' }],
      [
        'browser.tabCreate',
        {
          worktree: 'id:workspace-1',
          url: 'https://example.com',
          activate: true
        }
      ],
      [
        'session.tabs.activate',
        {
          worktree: 'id:workspace-1',
          tabId: 'tab-1',
          leafId: 'leaf-1',
          notifyClients: false,
          navigation: 'caller',
          intent: 'user'
        }
      ],
      ['session.tabs.close', { worktree: 'id:workspace-1', tabId: 'tab-1', reason: 'user' }]
    ])
  })

  it('forwards only snapshot events and preserves subscription cleanup', () => {
    const unsubscribe = vi.fn()
    let listener: ((event: unknown) => void) | null = null
    const subscribe = vi.fn((_method, _params, onData) => {
      listener = onData
      return unsubscribe
    })
    const onSnapshot = vi.fn()
    const operations = nativeHostSessionTabOperations({
      subscribe
    } as unknown as RpcClient)

    const cleanup = operations.subscribe('workspace-1', onSnapshot, vi.fn())
    listener?.({ type: 'ready' })
    listener?.({ type: 'updated', ...sessionSnapshot(3) })
    cleanup()

    expect(subscribe).toHaveBeenCalledWith(
      'session.tabs.subscribe',
      { worktree: 'id:workspace-1' },
      expect.any(Function)
    )
    expect(onSnapshot).toHaveBeenCalledWith({
      type: 'updated',
      ...sessionSnapshot(3)
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  // Why: a host-side subscription cleanup ends the stream; without degrading, the tab
  // list freezes on its last snapshot and never refetches.
  it('degrades the stream on end and error rather than dropping them silently', () => {
    let listener: ((event: unknown) => void) | null = null
    const subscribe = vi.fn((_method, _params, onData) => {
      listener = onData
      return vi.fn()
    })
    const onSnapshot = vi.fn()
    const onError = vi.fn()
    const operations = nativeHostSessionTabOperations({ subscribe } as unknown as RpcClient)

    operations.subscribe('workspace-1', onSnapshot, onError)
    listener?.({ type: 'end' })
    listener?.({ type: 'error' })

    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(2)
  })

  // Why: a relay-to-direct cutover rejects the in-flight request; activation is idempotent,
  // so one retry keeps the host's active tab in step with the tab the user just tapped.
  it('retries activation once after a logical client cutover', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockRejectedValueOnce(new LogicalClientCutoverError('cutover'))
      .mockResolvedValueOnce({ ok: true, result: sessionSnapshot(4) })
    const operations = nativeHostSessionTabOperations({ sendRequest } as unknown as RpcClient)

    await expect(operations.activate('workspace-1', 'tab-1')).resolves.toEqual(sessionSnapshot(4))
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('loads enabled agent choices and creates the selected agent through named operations', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'settings.get') {
        return {
          ok: true,
          result: { settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] } }
        }
      }
      if (method === 'preflight.detectAgents') {
        return { ok: true, result: ['claude', 'codex'] }
      }
      if (method === 'session.tabs.createTerminal') {
        return { ok: true, result: { created: true } }
      }
      return { ok: true, result: sessionSnapshot(4) }
    })
    const operations = nativeHostSessionTabOperations({
      sendRequest
    } as unknown as RpcClient)

    await expect(operations.agentOptions('global-floating-terminal')).resolves.toEqual([
      { agent: 'codex', label: 'Codex' },
      { agent: 'claude', label: 'Claude' }
    ])
    await expect(operations.createAgent('global-floating-terminal', 'codex')).resolves.toEqual(
      sessionSnapshot(4)
    )
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.createTerminal', {
      worktree: 'id:global-floating-terminal',
      clientMutationId: expect.stringMatching(/^mobile-create:/),
      agent: 'codex',
      activate: false,
      select: true,
      navigation: 'caller'
    })
  })

  it('keeps refused closes visible to the shared screen', async () => {
    const operations = nativeHostSessionTabOperations({
      sendRequest: vi.fn().mockResolvedValue({
        ok: true,
        result: { closed: true, refused: true, refusalReason: 'live-host-pty' }
      })
    } as unknown as RpcClient)

    await expect(operations.close('workspace-1', 'tab-1')).resolves.toEqual({
      outcome: 'refused',
      reason: 'live-host-pty'
    })
  })
})

function sessionSnapshot(snapshotVersion: number) {
  return {
    worktree: 'workspace-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    tabs: [],
    activeTabId: null,
    activeTabType: null
  }
}
