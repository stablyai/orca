import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FormatModule from './format'

vi.mock('./format', async () => {
  const actual = await vi.importActual<typeof FormatModule>('./format')
  return { ...actual, printResult: vi.fn() }
})

import { printResult } from './format'
import { WORKTREE_HANDLERS } from './handlers/worktree'

const worktree = {
  id: 'repo_1::/workspace',
  branch: 'feature',
  path: '/workspace',
  parentWorktreeId: null,
  childWorktreeIds: []
}

describe('public worktree workspace identity', () => {
  beforeEach(() => {
    vi.mocked(printResult).mockReset()
  })

  it('adds workspaceKey to current and show responses', async () => {
    const call = vi.fn().mockResolvedValue({ result: { worktree } })
    const context = {
      flags: new Map([['worktree', 'id:repo_1::/workspace']]),
      client: { call },
      cwd: '/workspace',
      json: true
    } as never

    await WORKTREE_HANDLERS['worktree show'](context)

    expect(vi.mocked(printResult).mock.calls[0]?.[0]).toMatchObject({
      result: { worktree: { workspaceKey: 'worktree:repo_1::/workspace' } }
    })
  })

  it('adds workspaceKey to every listed response and human formatter input', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { worktrees: [worktree], totalCount: 1, truncated: false }
    })

    await WORKTREE_HANDLERS['worktree list']({
      flags: new Map(),
      client: { call },
      cwd: '/workspace',
      json: false
    } as never)

    const response = vi.mocked(printResult).mock.calls[0]?.[0]
    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: never) => string)
      | undefined
    expect(response).toMatchObject({
      result: { worktrees: [{ workspaceKey: 'worktree:repo_1::/workspace' }] }
    })
    expect(formatter?.(response?.result as never)).toContain(
      'workspaceKey: worktree:repo_1::/workspace'
    )
  })
})
