import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch as dispatchCliCommand } from '../../dispatch/dispatch'
import { RuntimeClient } from '../../runtime/client'

describe('orchestration task-update --note runtime capability check', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fails clearly when connected to an older runtime that lacks task-update --note support', async () => {
    const client = new RuntimeClient('/tmp/orca-unused', 1_000, null, null)
    vi.spyOn(client, 'call').mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        return {
          id: 'req_status',
          ok: true,
          result: { capabilities: [] },
          _meta: { runtimeId: 'rt_old' }
        }
      }
      throw new Error(`unexpected ${method}`)
    })

    await expect(
      dispatchCliCommand(['orchestration', 'task-update'], {
        flags: new Map([
          ['from', 'term_worker'],
          ['note', 'running checks']
        ]),
        client,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: "This Orca doesn't support task-update --note yet."
    })

    await expect(
      dispatchCliCommand(['orchestration', 'task-update'], {
        flags: new Map([
          ['id', 'task_1'],
          ['status', 'dispatched'],
          ['note', 'combined']
        ]),
        client,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--note is for passive worker updates and cannot be combined with --status.'
    })
  })
})
