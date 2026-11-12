import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectEnclosingWorktreeSelectionOnHost } from './caller-host-worktree-selection'
import type { CatalogRow } from './workspace-catalog-row'
import { readEnclosingWorkspaceCatalog } from './enclosing-workspace-catalog'
import { RuntimeClient } from '../runtime/client'
import { okFixture } from '../test-fixtures'

function select(rows: CatalogRow[], cwd: string, caller?: string[]) {
  return selectEnclosingWorktreeSelectionOnHost(rows, cwd, 'local', caller)?.selector
}

function clientAnswering(answer: (method: string) => ReturnType<typeof okFixture>): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-enclosing-rule', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (method: string) => answer(method))
  return client
}

// Symlinks need privileges on Windows.
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
