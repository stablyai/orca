import { describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { MISSION_HANDLERS } from './mission'

function context(
  client: RuntimeClient,
  values: Record<string, string | boolean> = {}
): HandlerContext {
  return {
    client,
    flags: new Map(Object.entries({ text: 'Inspect this task.', ...values })),
    cwd: '/workspace/folder',
    json: false
  }
}

describe('mission start workspace selection', () => {
  it.each([
    ['runtime unavailable', new RuntimeClientError('runtime_unavailable', 'runtime unavailable')],
    [
      'authentication failure',
      new RuntimeClientError('authentication_failed', 'authentication failed')
    ],
    ['transport failure', new Error('socket closed')]
  ])('propagates a local %s instead of calling it a missing workspace', async (_label, error) => {
    const call = vi.fn(async () => {
      throw error
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient

    await expect(MISSION_HANDLERS['mission start'](context(client))).rejects.toBe(error)

    expect(call).toHaveBeenCalledWith('worktree.list', { limit: 10_000 })
  })

  it('explains that an unmanaged local directory needs an explicit workspace', async () => {
    const call = vi.fn(async () => ({ result: { worktrees: [] } }))
    const client = { call, isRemote: false } as unknown as RuntimeClient

    await expect(MISSION_HANDLERS['mission start'](context(client))).rejects.toMatchObject({
      code: 'selector_not_found',
      message: 'orca-sub requires an Orca-managed workspace. Run it inside a managed workspace or pass --worktree.'
    })

    expect(call).toHaveBeenCalledWith('worktree.list', { limit: 10_000 })
  })

  it('uses an explicit selector without resolving the local directory', async () => {
    const plannerFailure = new Error('stop after plan request')
    const call = vi.fn(async (method: string) => {
      if (method === 'mission.plan') {
        throw plannerFailure
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient

    await expect(
      MISSION_HANDLERS['mission start'](
        context(client, { worktree: 'id:repo::/workspace/folder', from: 'term_coord' })
      )
    ).rejects.toBe(plannerFailure)

    expect(call).toHaveBeenCalledWith('mission.plan', {
      text: 'Inspect this task.',
      worktree: 'id:repo::/workspace/folder',
      agent: undefined
    })
    expect(call).not.toHaveBeenCalledWith('worktree.list', expect.anything())
  })

  it('does not resolve the local directory against a remote runtime', async () => {
    const call = vi.fn()
    const client = { call, isRemote: true } as unknown as RuntimeClient

    await expect(MISSION_HANDLERS['mission start'](context(client))).rejects.toMatchObject({
      code: 'selector_not_found',
      message: 'orca-sub requires an Orca-managed workspace. Run it inside a managed workspace or pass --worktree.'
    })

    expect(call).not.toHaveBeenCalled()
  })
})
