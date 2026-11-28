import { describe, expect, it } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { WORKTREE_HANDLERS } from './worktree'

describe('orca worktree create --timeout-ms', () => {
  it.each(['0', '2147483648'])('rejects %s before any runtime request', async (timeoutMs) => {
    const calls: string[] = []
    const rejectingClient = {
      isRemote: false,
      call: async (method: string) => {
        calls.push(method)
        throw new Error(`unexpected ${method}`)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a client that rejects every call; the handler must fail before it reaches any member but call and isRemote
    const client = rejectingClient as unknown as RuntimeClient
    const flags = new Map<string, string | boolean>([
      ['name', 'wt'],
      ['timeout-ms', timeoutMs]
    ])

    await expect(
      WORKTREE_HANDLERS['worktree create']({ flags, client, cwd: '/tmp/repo', json: true })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})
