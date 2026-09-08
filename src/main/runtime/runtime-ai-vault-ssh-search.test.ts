import { expect, it, vi } from 'vitest'
import { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'
import type { IPtyProvider } from '../providers/types'

it('routes nested search and policy only through the selected runtime’s registered provider', async () => {
  const request = vi.fn(async () => ({ marker: 'C-only' }))
  const provider = vi.fn((id: string) =>
    id === 'C' ? ({ requestHostRpc: request } as unknown as IPtyProvider) : undefined
  )
  const localStore = vi.fn()
  const commands = new RuntimeAiVaultCommands(() => null, localStore, provider)
  const signal = new AbortController().signal
  expect(
    await commands.sshSearch('C', 'query', { query: 'same', executionHostId: 'runtime:A' }, signal)
  ).toEqual({ marker: 'C-only' })
  expect(request).toHaveBeenCalledWith(
    'aiVault.searchSessions',
    { query: 'same' },
    { signal, timeoutMs: 15_000 }
  )
  await commands.sshSearch('C', 'configure', { enabled: false, clearIndex: true }, signal)
  expect(request).toHaveBeenLastCalledWith(
    'aiVault.searchConfigure',
    { enabled: false, clearIndex: true },
    { signal, timeoutMs: 15_000 }
  )
  await expect(commands.sshSearch('unknown', 'query', { query: 'same' })).rejects.toThrow(
    'not connected'
  )
  expect(localStore).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledTimes(2)
})

it('classifies only affirmative method absence as unsupported, never disconnects', async () => {
  const requestHostRpc = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('method absent'), { code: -32601 }))
  const commands = new RuntimeAiVaultCommands(
    () => null,
    () => null,
    () => ({ requestHostRpc }) as unknown as IPtyProvider
  )
  expect(await commands.sshSearch('C', 'status', {})).toMatchObject({
    available: false,
    applied: false
  })
  requestHostRpc.mockRejectedValue(new Error('connection lost'))
  await expect(commands.sshSearch('C', 'status', {})).rejects.toThrow('connection lost')
})
