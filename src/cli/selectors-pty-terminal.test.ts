import { describe, expect, it, vi } from 'vitest'
import { resolveTerminalSelector } from './selectors'
import type { RuntimeClient } from './runtime-client'

describe('resolveTerminalSelector', () => {
  it('passes through ordinary handles', async () => {
    const client = { call: vi.fn() } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('term_abc', client)).resolves.toBe('term_abc')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('resolves pty:<id> via terminal.list without visual layouts', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminals: [
          { handle: 'term_new', ptyId: 'pty-stable-1' },
          { handle: 'term_other', ptyId: 'pty-2' }
        ],
        truncated: false,
        totalCount: 2
      }
    })
    const client = { call } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('pty:pty-stable-1', client)).resolves.toBe('term_new')
    expect(call).toHaveBeenCalledWith('terminal.list', {
      limit: 5000,
      includeVisualLayouts: false
    })
  })

  it('rejects empty pty ids', async () => {
    const client = { call: vi.fn() } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('pty:', client)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(client.call).not.toHaveBeenCalled()
  })

  it('rejects unknown pty ids with terminal_not_found', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminals: [{ handle: 'term_only', ptyId: 'pty-1' }],
        truncated: false,
        totalCount: 1
      }
    })
    const client = { call } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('pty:missing', client)).rejects.toMatchObject({
      code: 'terminal_not_found'
    })
  })

  it('mentions truncation when the list page misses the ptyId', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminals: [{ handle: 'term_only', ptyId: 'pty-1' }],
        truncated: true,
        totalCount: 900
      }
    })
    const client = { call } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('pty:beyond-page', client)).rejects.toMatchObject({
      code: 'terminal_not_found',
      message: expect.stringMatching(/truncated/i)
    })
  })
})
