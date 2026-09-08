import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS } from './mobile-web-source-control-compare'
import { MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS } from './mobile-web-source-control-history'

const worktree = 'id:private-host-workspace'
const OID = 'a'.repeat(40)
const METHODS = [
  ...MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS
]

function fixture(name: string, runtimeMethod: string, result: unknown) {
  const call = vi.fn().mockResolvedValue(result)
  const method = METHODS.find((entry) => entry.name === name)!
  return {
    call,
    run: async (params: Record<string, unknown> = {}) =>
      method.handler(method.params!.parse({ worktree, ...params }), {
        runtime: { [runtimeMethod]: call }
      } as unknown as RpcContext)
  }
}

function historyItem(index: number, message: string) {
  return {
    id: index.toString(16).padStart(40, '0'),
    parentIds: [],
    subject: 'subject',
    message,
    references: []
  }
}

describe('bounded host Source Control history reads', () => {
  it('caps a branch list the page cannot render and reports the true total', async () => {
    const f = fixture('mobileWeb.sourceControl.branches', 'listRuntimeGitLocalBranches', {
      current: 'main',
      branches: Array.from({ length: 500 }, (_, index) => `branch-${index}`)
    })
    const result = (await f.run()) as { branches: string[]; totalCount: number; truncated: boolean }
    expect(result.branches).toHaveLength(128)
    expect(result).toMatchObject({ totalCount: 500, truncated: true })
    expect(JSON.stringify(result)).not.toContain('workspaceId')
    expect(f.call).toHaveBeenCalledWith(worktree)
  })

  it('drops a branch name the page contract cannot address', async () => {
    const f = fixture('mobileWeb.sourceControl.branches', 'listRuntimeGitLocalBranches', {
      current: '--upload-pack=evil',
      branches: ['main', '--upload-pack=evil']
    })
    await expect(f.run()).resolves.toMatchObject({
      current: null,
      branches: ['main'],
      truncated: true
    })
  })

  it('drops history items that would overrun the bridge budget and marks the page incomplete', async () => {
    const f = fixture('mobileWeb.sourceControl.history', 'getRuntimeGitHistory', {
      items: Array.from({ length: 100 }, (_, index) => historyItem(index, 'x'.repeat(16 * 1024))),
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 100
    })
    const result = (await f.run({ limit: 100 })) as {
      items: { message: string }[]
      hasMore: boolean
    }
    expect(result.items.length).toBeLessThan(100)
    expect(result.hasMore).toBe(true)
    expect(result.items[0]!.message).toHaveLength(8 * 1024)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192 * 1024)
    expect(f.call).toHaveBeenCalledWith(worktree, { limit: 100 })
  })

  it('drops the desktop-only fields the page contract does not carry', async () => {
    const f = fixture('mobileWeb.sourceControl.history', 'getRuntimeGitHistory', {
      items: [
        {
          ...historyItem(1, 'feat: ship'),
          authorEmail: 'private@example.com',
          statistics: { files: 1, insertions: 2, deletions: 3 },
          references: [{ id: 'ref', name: 'main', color: 'git-graph-ref' }]
        }
      ],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    })
    const result = await f.run()
    expect(JSON.stringify(result)).not.toMatch(/authorEmail|statistics|color/)
    expect(result).toMatchObject({ items: [{ references: [{ id: 'ref', name: 'main' }] }] })
  })

  it('forwards the requested base ref and defaults the history limit', async () => {
    const f = fixture('mobileWeb.sourceControl.history', 'getRuntimeGitHistory', {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    })
    await f.run({ baseRef: 'origin/main' })
    expect(f.call).toHaveBeenCalledWith(worktree, { limit: 50, baseRef: 'origin/main' })
    await expect(f.run({ baseRef: '--upload-pack=evil' })).rejects.toThrow()
  })
})

describe('bounded host Source Control compares', () => {
  it('clips a branch compare to the response budget and keeps the reported file count', async () => {
    const f = fixture('mobileWeb.sourceControl.branchCompare', 'getRuntimeGitBranchCompare', {
      summary: {
        baseRef: 'main',
        baseOid: OID,
        compareRef: 'HEAD',
        headOid: 'b'.repeat(40),
        mergeBase: OID,
        changedFiles: 6_000,
        status: 'ready'
      },
      entries: Array.from({ length: 6_000 }, (_, index) => ({
        path: `src/${'deep/'.repeat(8)}file-${index}.ts`,
        status: 'modified'
      }))
    })
    const result = (await f.run({ baseRef: 'main' })) as {
      entries: unknown[]
      changedFiles: number
      truncated: boolean
    }
    expect(result.entries.length).toBeLessThan(4_000)
    expect(result).toMatchObject({ changedFiles: 6_000, truncated: true })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192 * 1024)
    expect(f.call).toHaveBeenCalledWith(worktree, 'main')
  })

  it('drops a changed file the page cannot address and reports a loading compare as an error', async () => {
    const f = fixture('mobileWeb.sourceControl.branchCompare', 'getRuntimeGitBranchCompare', {
      summary: {
        baseRef: 'main',
        baseOid: null,
        compareRef: 'HEAD',
        headOid: null,
        mergeBase: null,
        changedFiles: 2,
        status: 'loading'
      },
      entries: [
        { path: '../outside.ts', status: 'modified' },
        { path: 'src/app.ts', status: 'modified' }
      ]
    })
    await expect(f.run({ baseRef: 'main' })).resolves.toMatchObject({
      status: 'error',
      entries: [{ relativePath: 'src/app.ts' }],
      truncated: true
    })
  })

  it('answers a commit compare in one page and refuses a short commit id', async () => {
    const f = fixture('mobileWeb.sourceControl.commitCompare', 'getRuntimeGitCommitCompare', {
      summary: {
        commitOid: OID,
        parentOid: null,
        compareRef: 'HEAD',
        baseRef: 'parent',
        changedFiles: 1,
        status: 'ready'
      },
      entries: [{ path: 'src/app.ts', status: 'modified', added: 2, removed: 1 }]
    })
    await expect(f.run({ commitId: OID })).resolves.toMatchObject({
      commitId: OID,
      entries: [{ relativePath: 'src/app.ts', added: 2, removed: 1 }],
      truncated: false
    })
    await expect(f.run({ commitId: 'abc1234' })).rejects.toThrow()
  })
})
