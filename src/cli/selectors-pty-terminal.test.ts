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
          { handle: 'term_new', ptyId: 'pty-stable-1', connected: true },
          { handle: 'term_other', ptyId: 'pty-2', connected: true }
        ],
        truncated: false,
        totalCount: 2
      }
    })
    const client = { call } as unknown as RuntimeClient
    await expect(resolveTerminalSelector('pty:pty-stable-1', client)).resolves.toBe('term_new')
    expect(call).toHaveBeenCalledWith('terminal.list', {
      limit: 200,
      ptyId: 'pty-stable-1',
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
  })

  it('supports a bounded old-host response that ignores the ptyId filter', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminals: [
          { handle: 'term_other', ptyId: 'pty-2', connected: true },
          { handle: 'term_new', ptyId: 'pty-stable-1', connected: true }
        ],
        truncated: false,
        totalCount: 2
      }
    })
    const client = { call } as unknown as RuntimeClient

    await expect(resolveTerminalSelector('pty:pty-stable-1', client)).resolves.toBe('term_new')
  })

  it('ignores disconnected records that reuse the requested ptyId', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminals: [
          { handle: 'term_stale', ptyId: 'pty-stable-1', connected: false },
          { handle: 'term_live', ptyId: 'pty-stable-1', connected: true }
        ],
        truncated: false,
        totalCount: 2
      }
    })
    const client = { call } as unknown as RuntimeClient

    await expect(resolveTerminalSelector('pty:pty-stable-1', client)).resolves.toBe('term_live')
  })

  it('rejects a disconnected-only match', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminals: [{ handle: 'term_stale', ptyId: 'pty-stable-1', connected: false }],
        truncated: false,
        totalCount: 1
      }
    })
    const client = { call } as unknown as RuntimeClient

    await expect(resolveTerminalSelector('pty:pty-stable-1', client)).rejects.toMatchObject({
      code: 'terminal_not_found'
    })
  })

  it('falls back to cached connected state when fresh liveness is unavailable', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_liveness_unavailable'))
      .mockResolvedValueOnce({
        result: {
          terminals: [{ handle: 'term_cached', ptyId: 'pty-stable-1', connected: true }],
          truncated: false,
          totalCount: 1
        }
      })
    const client = { call } as unknown as RuntimeClient

    await expect(resolveTerminalSelector('pty:pty-stable-1', client)).resolves.toBe('term_cached')
    expect(call).toHaveBeenNthCalledWith(2, 'terminal.list', {
      limit: 200,
      ptyId: 'pty-stable-1',
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
        terminals: [{ handle: 'term_only', ptyId: 'pty-1', connected: true }],
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
        terminals: [{ handle: 'term_only', ptyId: 'pty-1', connected: true }],
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
