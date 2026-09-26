import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from './runtime-client'
import { getTerminalHandle } from './selectors'

describe('getTerminalHandle', () => {
  it('uses the active terminal only when --terminal is omitted', async () => {
    const call = vi.fn().mockResolvedValue({ result: { handle: 'term_active' } })

    await expect(
      getTerminalHandle(new Map(), '/tmp/worktree', {
        isRemote: true,
        call
      } as unknown as RuntimeClient)
    ).resolves.toBe('term_active')

    expect(call).toHaveBeenCalledWith('terminal.resolveActive', { worktree: undefined })
  })

  it('rejects an explicitly empty --terminal before resolving the active terminal', async () => {
    const call = vi.fn()

    await expect(
      getTerminalHandle(new Map([['terminal', '']]), '/tmp/worktree', {
        isRemote: true,
        call
      } as unknown as RuntimeClient)
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    expect(call).not.toHaveBeenCalled()
  })

  it('rejects a bare --terminal flag before resolving the active terminal', async () => {
    const call = vi.fn()

    await expect(
      getTerminalHandle(new Map([['terminal', true]]), '/tmp/worktree', {
        isRemote: true,
        call
      } as unknown as RuntimeClient)
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    expect(call).not.toHaveBeenCalled()
  })
})
