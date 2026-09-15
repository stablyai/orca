import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { TERMINAL_HANDLERS } from './terminal'

const CREATE_FLAGS = new Map<string, string | boolean>([['worktree', 'path:/tmp/worktree']])

describe('terminal create CLI contract', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['non-string', 42],
    ['empty', ''],
    ['whitespace-only', '   ']
  ])('fails closed for a %s terminal handle', async (_label, handle) => {
    const call = vi.fn().mockResolvedValue({
      result: {
        terminal: {
          handle,
          worktreeId: 'wt-1',
          title: null
        }
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      TERMINAL_HANDLERS['terminal create']({
        flags: CREATE_FLAGS,
        client: { call, isRemote: false } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('without a terminal handle')
    })
    expect(log).not.toHaveBeenCalled()
  })

  it('prints a successful create response with a valid handle', async () => {
    const result = {
      result: {
        terminal: {
          handle: 'term-created',
          worktreeId: 'wt-1',
          title: null
        }
      }
    }
    const call = vi.fn().mockResolvedValue(result)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal create']({
      flags: CREATE_FLAGS,
      client: { call, isRemote: false } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({ worktree: 'path:/tmp/worktree' })
    )
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      result: { terminal: { handle: 'term-created' } }
    })
  })
})
