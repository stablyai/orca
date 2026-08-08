import { describe, expect, it, vi } from 'vitest'
import { resolveTerminalSelector } from './selectors'
import { RuntimeClientError } from './runtime/types'
import type { RuntimeClient } from './runtime-client'

describe('resolveTerminalSelector', () => {
  it('passes through ordinary handles', async () => {
    const client = { call: vi.fn() } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('term_abc', client)).resolves.toBe('term_abc')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('resolves pty:<id> via terminal.list', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminals: [
          { handle: 'term_new', ptyId: 'pty-stable-1' },
          { handle: 'term_other', ptyId: 'pty-2' }
        ]
      }
    })
    const client = { call } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('pty:pty-stable-1', client)).resolves.toBe('term_new')
    expect(call).toHaveBeenCalledWith('terminal.list', { limit: 500 })
  })

  it('rejects unknown pty ids', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { terminals: [{ handle: 'term_only', ptyId: 'pty-1' }] }
    })
    const client = { call } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('pty:missing', client)).rejects.toBeInstanceOf(
      RuntimeClientError
    )
  })
})
