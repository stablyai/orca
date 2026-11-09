import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
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

describe('owners registered at one path', () => {
  it('refuses distinct registrations without a caller, whatever their repo', () => {
    const repoA = {
      id: 'repo-a::checkout',
      repoId: 'repo-a',
      path: '/tmp/hub/app',
      hostId: 'local' as const
    }
    const repoB = {
      id: 'repo-b::checkout',
      repoId: 'repo-b',
      path: '/tmp/hub/app',
      hostId: 'local' as const
    }
    for (const rows of [
      [repoA, repoB],
      [repoB, repoA]
    ]) {
      expect(() => select(rows, '/tmp/hub/app/src')).toThrow(
        expect.objectContaining({ code: 'selector_ambiguous' })
      )
      expect(select(rows, '/tmp/hub/app/src', [repoB.id])).toBe('id:repo-b::checkout')
    }
  })
})

// Symlinks need privileges on Windows; macOS /tmp and Linux bind aliases behave like this fixture.
describe.skipIf(process.platform === 'win32')('symlink aliases on the caller filesystem', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-enclosing-alias-')))
  const real = join(root, 'real')
  const alias = join(root, 'alias')
  mkdirSync(join(real, 'hub', 'app', 'src'), { recursive: true })
  symlinkSync(real, alias)
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const outer = (base: string) => ({
    id: 'folder:outer',
    path: join(base, 'hub'),
    hostId: 'local' as const
  })
  const inner = (base: string, kind: 'folder' | 'worktree') =>
    kind === 'folder'
      ? { id: 'folder:inner', path: join(base, 'hub', 'app'), hostId: 'local' as const }
      : {
          id: 'repo::inner',
          repoId: 'repo',
          path: join(base, 'hub', 'app'),
          hostId: 'local' as const
        }

  it.each([
    ['folder', real, alias],
    ['folder', alias, real],
    ['worktree', real, alias],
    ['worktree', alias, real]
  ] as const)(
    'picks the deeper %s stored under one spelling from cwd under the other',
    (kind, cwdBase, innerBase) => {
      const cwd = join(cwdBase, 'hub', 'app', 'src')
      const expected = kind === 'folder' ? 'folder:inner' : 'id:repo::inner'
      expect(select([outer(cwdBase), inner(innerBase, kind)], cwd)).toBe(expected)
      expect(select([inner(innerBase, kind)], cwd)).toBe(expected)
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'picks a %s registered through a differently named link, from cwd via a second link',
    (kind) => {
      const workspaceLink = join(root, `workspace-link-${kind}`)
      const cwdLink = join(root, `cwd-link-${kind}`)
      symlinkSync(join(real, 'hub', 'app'), workspaceLink)
      symlinkSync(join(real, 'hub', 'app'), cwdLink)
      const registered =
        kind === 'folder'
          ? { id: 'folder:inner', path: workspaceLink, hostId: 'local' as const }
          : { id: 'repo::inner', repoId: 'repo', path: workspaceLink, hostId: 'local' as const }
      const expected = kind === 'folder' ? 'folder:inner' : 'id:repo::inner'
      for (const cwd of [join(real, 'hub', 'app', 'src'), join(cwdLink, 'src')]) {
        expect(select([outer(real), registered], cwd)).toBe(expected)
      }
    }
  )

  it('keeps an aliased folder in the catalog prefilter', async () => {
    const client = clientAnswering((method) =>
      method === 'worktree.list'
        ? okFixture('list', { worktrees: [] })
        : method === 'folderWorkspace.list'
          ? okFixture('folders', {
              folderWorkspaces: [
                { id: 'inner', folderPath: join(alias, 'hub', 'app'), projectGroupId: 'g' }
              ]
            })
          : method === 'projectGroup.list'
            ? okFixture('groups', { groups: [{ id: 'g' }] })
            : okFixture('repos', { repos: [] })
    )
    expect(await readEnclosingWorkspaceCatalog(client, join(real, 'hub', 'app', 'src'))).toEqual([
      { id: 'folder:inner', path: join(alias, 'hub', 'app'), hostId: 'local' }
    ])
  })
})

describe('a folder workspace whose host is unknown', () => {
  const unresolvedHub = { id: 'folder:hub', path: '/tmp/hub', hostUnresolved: true as const }

  it('refuses rather than skipping it when it is the innermost owner', () => {
    for (const rows of [[unresolvedHub], [unresolvedHub, atHub]]) {
      expect(() => select(rows, '/tmp/hub/notes')).toThrow(
        expect.objectContaining({
          code: 'selector_ambiguous',
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
