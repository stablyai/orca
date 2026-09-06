import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostSessionTerminalOperations } from './native-host-session-terminal-operations'

describe('native host session terminal operations', () => {
  it('preserves the existing mobile subscription and input RPC semantics', async () => {
    const unsubscribe = vi.fn()
    let onData: ((event: unknown) => void) | null = null
    const subscribe = vi.fn((_method, _params, listener) => {
      onData = listener
      return unsubscribe
    })
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
    const operations = nativeHostSessionTerminalOperations({
      subscribe,
      sendRequest
    } as unknown as RpcClient)
    const onEvent = vi.fn()

    const cleanup = operations.subscribe(
      {
        workspaceId: 'workspace-1',
        terminalId: 'terminal-native-1',
        clientId: 'device-1',
        viewport: { cols: 90, rows: 30 },
        visible: true,
        capabilities: { terminalBinaryStream: 1 }
      },
      onEvent,
      vi.fn()
    )
    onData?.({ type: 'data', chunk: 'hello' })

    expect(subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      {
        terminal: 'terminal-native-1',
        client: { id: 'device-1', type: 'mobile' },
        viewport: { cols: 90, rows: 30 },
        capabilities: { terminalBinaryStream: 1 }
      },
      expect.any(Function)
    )
    expect(onEvent).toHaveBeenCalledWith({ type: 'data', chunk: 'hello' })
    await expect(operations.sendInput('terminal-native-1', 'ls', true, 'device-1')).resolves.toBe(
      true
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'terminal-native-1',
        text: 'ls',
        enter: true,
        client: { id: 'device-1', type: 'mobile' }
      },
      { failWhenDisconnected: true }
    )
    await expect(
      operations.setDisplayMode('terminal-native-1', 'auto', { cols: 90, rows: 30 }, 'device-1')
    ).resolves.toBe(true)
    await expect(operations.rename('terminal-native-1', 'Build')).resolves.toBe(true)
    await expect(operations.clear('terminal-native-1')).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledWith('terminal.setDisplayMode', {
      terminal: 'terminal-native-1',
      mode: 'auto',
      client: { id: 'device-1', type: 'mobile' },
      viewport: { cols: 90, rows: 30 }
    })
    expect(sendRequest).toHaveBeenCalledWith('terminal.rename', {
      terminal: 'terminal-native-1',
      title: 'Build'
    })
    expect(sendRequest).toHaveBeenCalledWith('terminal.clearBuffer', {
      terminal: 'terminal-native-1'
    })

    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps query replies capability-gated and bound to an active subscription', async () => {
    const operations = nativeHostSessionTerminalOperations({
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      sendRequest: vi.fn().mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
    } as unknown as RpcClient)
    operations.subscribe(
      {
        workspaceId: 'workspace-1',
        terminalId: 'terminal-native-1',
        clientId: null,
        viewport: null,
        visible: true,
        capabilities: { terminalBinaryStream: 1 }
      },
      vi.fn(),
      vi.fn()
    )

    await expect(
      operations.sendQueryReply('terminal-native-1', '\u001b[0n', null, false)
    ).resolves.toBe(false)
    await expect(
      operations.sendQueryReply('terminal-native-1', '\u001b[0n', null, true)
    ).resolves.toBe(true)
  })
})
