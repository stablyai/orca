import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostSessionTerminalOperations } from './native-host-session-terminal-operations'

describe('native host session terminal operations', () => {
  it('preserves the existing mobile terminal input RPC semantics', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
    const operations = nativeHostSessionTerminalOperations({
      sendRequest
    } as unknown as RpcClient)

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
  })
})
