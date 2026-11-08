import { describe, expect, it, vi } from 'vitest'
import {
  selectEnclosingWorktreeSelectionOnHost,
  type CatalogRow
} from './caller-host-worktree-selection'
import { readEnclosingWorkspaceCatalog } from './enclosing-workspace-catalog'
import { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { okFixture } from './test-fixtures'

const hubFolder = { id: 'folder:hub', path: '/tmp/hub', hostId: 'local' as const }
const innerFolder = { id: 'folder:inner', path: '/tmp/hub/inner', hostId: 'local' as const }
const nested = {
  id: 'repo::/tmp/hub/app',
  path: '/tmp/hub/app',
  hostId: 'local' as const,
  repoId: 'repo'
}
const atHub = { id: 'repo::/tmp/hub', path: '/tmp/hub', hostId: 'local' as const, repoId: 'repo' }

function select(rows: CatalogRow[], cwd: string, caller?: string[]) {
  return selectEnclosingWorktreeSelectionOnHost(rows, cwd, 'local', caller)?.selector
}

describe('one enclosing-workspace rule across worktrees and folder workspaces', () => {
  it('picks the innermost workspace of either kind', () => {
    expect(select([hubFolder, nested], '/tmp/hub/notes')).toBe('folder:hub')
    expect(select([hubFolder, nested], '/tmp/hub/app/src')).toBe('id:repo::/tmp/hub/app')
    // The caller's outer folder no longer beats a deeper one.
    expect(select([hubFolder, innerFolder], '/tmp/hub/inner/x', ['folder:hub'])).toBe(
      'folder:inner'
    )
  })

  it("breaks an equal-depth tie with the caller's own workspace, otherwise refuses", () => {
    expect(select([atHub, hubFolder], '/tmp/hub/x', ['folder:hub'])).toBe('folder:hub')
    expect(select([hubFolder, atHub], '/tmp/hub/x', [atHub.id])).toBe('id:repo::/tmp/hub')
    for (const rows of [
      [atHub, hubFolder],
      [hubFolder, atHub]
    ]) {
      expect(() => select(rows, '/tmp/hub/x')).toThrow(
        expect.objectContaining({ code: 'selector_ambiguous' })
      )
    }
  })
})

function clientAnswering(answer: (method: string) => ReturnType<typeof okFixture>): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-enclosing-rule', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (method: string) => answer(method))
  return client
}

describe('a folder workspace whose host is unknown', () => {
  const unresolvedHub = { id: 'folder:hub', path: '/tmp/hub', hostUnresolved: true as const }

  it('refuses rather than skipping it when it is the innermost owner', () => {
    for (const rows of [[unresolvedHub], [unresolvedHub, atHub]]) {
      expect(() => select(rows, '/tmp/hub/notes')).toThrow(
        expect.objectContaining({
          code: 'selector_ambiguous',
          message: expect.stringContaining("can't tell which host owns the folder workspace"),
          data: expect.objectContaining({
            nextSteps: expect.arrayContaining([
              'Pass --worktree folder:hub to target the folder workspace itself.'
            ])
          })
        })
      )
    }
  })

  it('does not block a deeper worktree inside it', () => {
    expect(select([unresolvedHub, nested], '/tmp/hub/app/src')).toBe('id:repo::/tmp/hub/app')
  })
})

describe('enclosing-workspace catalog', () => {
  it('derives folder hosts and keeps only folders that enclose cwd', async () => {
    const client = clientAnswering((method) =>
      method === 'worktree.list'
        ? okFixture('list', { worktrees: [nested] })
        : method === 'folderWorkspace.list'
          ? okFixture('folders', {
              folderWorkspaces: [
                { id: 'hub', folderPath: '/tmp/hub', projectGroupId: 'local-group' },
                { id: 'far', folderPath: '/tmp/far', projectGroupId: 'local-group' },
                { id: 'ssh-hub', folderPath: '/tmp/hub', projectGroupId: 'ssh-group' }
              ]
            })
          : method === 'projectGroup.list'
            ? okFixture('groups', {
                groups: [{ id: 'local-group' }, { id: 'ssh-group', connectionId: 'box' }]
              })
            : okFixture('repos', { repos: [] })
    )
    expect(await readEnclosingWorkspaceCatalog(client, '/tmp/hub/notes')).toEqual([
      nested,
      { id: 'folder:hub', path: '/tmp/hub', hostId: 'local' },
      { id: 'folder:ssh-hub', path: '/tmp/hub', hostId: 'ssh:box' }
    ])
  })

  it('keeps an enclosing folder whose host inputs are missing, marked unresolved', async () => {
    const client = clientAnswering((method) => {
      if (method === 'worktree.list') {
        return okFixture('list', { worktrees: [] })
      }
      if (method === 'folderWorkspace.list') {
        return okFixture('folders', {
          folderWorkspaces: [{ id: 'hub', folderPath: '/tmp/hub', projectGroupId: 'group' }]
        })
      }
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    expect(await readEnclosingWorkspaceCatalog(client, '/tmp/hub/notes')).toEqual([
      { id: 'folder:hub', path: '/tmp/hub', hostUnresolved: true }
    ])
  })

  it('falls back to worktree rows only when the folder catalog is missing', async () => {
    const missing = clientAnswering((method) => {
      if (method === 'worktree.list') {
        return okFixture('list', { worktrees: [nested] })
      }
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    expect(await readEnclosingWorkspaceCatalog(missing, '/tmp/hub/app')).toEqual([nested])
    const down = clientAnswering((method) => {
      if (method === 'worktree.list') {
        return okFixture('list', { worktrees: [nested] })
      }
      throw new RuntimeClientError('runtime_unavailable', 'connection closed')
    })
    await expect(readEnclosingWorkspaceCatalog(down, '/tmp/hub/app')).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
  })
})
