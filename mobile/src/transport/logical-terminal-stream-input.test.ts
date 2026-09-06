import { describe, expect, it, vi } from 'vitest'
import { LogicalTerminalStreamInput } from './logical-terminal-stream-input'
import type { RpcClient } from './rpc-client'

describe('logical terminal input cutover', () => {
  it('keeps a pending old-stream prefix from falling back on a replacement old host', async () => {
    let resolve = (_accepted: boolean) => {}
    const original = new Promise<boolean>((r) => {
      resolve = r
    })
    let generation = 1
    let session = {
      supportsTerminalStreamInput: () => true,
      sendTerminalStreamInput: vi.fn(() => original)
    } as unknown as RpcClient
    const input = new LogicalTerminalStreamInput(() => ({ generation, session, available: true }))
    const prefix = input.send('t', 'prefix')!
    generation = 2
    session = {} as RpcClient
    expect(input.supports('t')).toBe(true)
    expect(await input.send('t', '\r')).toBe(false)
    resolve(true)
    expect(await prefix).toBe(false)
    expect(await input.send('t', '\r')).toBe(false)
    session = {
      supportsTerminalStreamInput: () => true,
      recoverTerminalStreamInput: () => true,
      sendTerminalStreamInput: vi.fn(() => Promise.resolve(true))
    } as unknown as RpcClient
    expect(await input.send('t', 'blocked')).toBe(false)
    expect(input.recover('t')).toBe(true)
    expect(await input.send('t', 'fresh')).toBe(true)
  })
})
