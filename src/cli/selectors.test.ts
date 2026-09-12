import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'
import { getBrowserWorktreeSelector } from './selectors'

function clientWith(call: unknown, options: { isRemote?: boolean } = {}): RuntimeClient {
  return { call, isRemote: options.isRemote ?? false } as unknown as RuntimeClient
}

function flags(values: Record<string, string | boolean> = {}): Map<string, string | boolean> {
  return new Map(Object.entries(values))
}

describe('getBrowserWorktreeSelector', () => {
  // Regression: replacing this with a catch-all turns an unavailable runtime into an
  // unscoped mission, which downstream handlers misreport as a missing workspace.
  it.each([
    ['runtime unavailable', new RuntimeClientError('runtime_unavailable', 'runtime unavailable')],
    [
      'authentication failure',
      new RuntimeClientError('authentication_failed', 'authentication failed')
    ],
    ['transport failure', new Error('socket closed')]
  ])(
    'propagates a local default %s instead of silently dropping the selector',
    async (_, error) => {
      const call = vi.fn(async () => {
        throw error
      })

      await expect(
        getBrowserWorktreeSelector(flags(), '/workspace/folder', clientWith(call))
      ).rejects.toBe(error)

      expect(call).toHaveBeenCalledWith('worktree.list', { limit: 10_000 })
    }
  )

  it('omits the local default selector when no managed workspace contains the folder cwd', async () => {
    const call = vi.fn(async () => {
      throw new RuntimeClientError('selector_not_found', 'no managed workspace')
    })

    await expect(
      getBrowserWorktreeSelector(flags(), '/workspace/folder', clientWith(call))
    ).resolves.toBeUndefined()
  })

  it('omits the local default selector when the runtime lists no managed workspaces', async () => {
    const call = vi.fn(async () => ({ result: { worktrees: [] } }))

    await expect(
      getBrowserWorktreeSelector(flags(), '/workspace/folder', clientWith(call))
    ).resolves.toBeUndefined()

    expect(call).toHaveBeenCalledWith('worktree.list', { limit: 10_000 })
  })

  it('uses the enclosing managed folder workspace for a local default selector', async () => {
    const call = vi.fn(async () => ({
      result: {
        worktrees: [
          {
            id: 'folder-workspace',
            path: '/workspace/folder',
            branch: null,
            repoId: null
          }
        ]
      }
    }))

    await expect(
      getBrowserWorktreeSelector(flags(), '/workspace/folder/src', clientWith(call))
    ).resolves.toBe('id:folder-workspace')
  })

  it('preserves an explicit worktree selector without resolving the local cwd', async () => {
    const call = vi.fn()

    await expect(
      getBrowserWorktreeSelector(
        flags({ worktree: 'id:repo::/workspace/folder' }),
        '/outside',
        clientWith(call)
      )
    ).resolves.toBe('id:repo::/workspace/folder')

    expect(call).not.toHaveBeenCalled()
  })

  it('leaves an omitted remote selector unscoped without resolving the client cwd', async () => {
    const call = vi.fn()

    await expect(
      getBrowserWorktreeSelector(flags(), '/client/folder', clientWith(call, { isRemote: true }))
    ).resolves.toBeUndefined()

    expect(call).not.toHaveBeenCalled()
  })
})
