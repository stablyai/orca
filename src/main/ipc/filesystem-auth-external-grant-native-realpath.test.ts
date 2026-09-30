import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  PATH_ACCESS_DENIED_MESSAGE,
  authorizeExternalPath,
  resolveAuthorizedPath
} from './filesystem-auth'

const fsMocks = vi.hoisted(() => ({
  jsRealpath: vi.fn((path: string) => path),
  nativeRealpath: vi.fn((path: string) => path)
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    realpathSync: Object.assign(fsMocks.jsRealpath, { native: fsMocks.nativeRealpath })
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, realpath: async (path: string) => fsMocks.nativeRealpath(path) }
})
vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: vi.fn(), isRepoRoot: vi.fn() }))

// Why: a mapped (`net use`) or subst drive — the JS realpath keeps `X:\…`, the native one returns
// the share or target path. Modelled with plain roots so the case runs on every platform.
const mappedDrive = resolve('/mapped-drive')
const shareRoot = resolve('/nas-share')

function toShare(path: string): string {
  const rel = relative(mappedDrive, path)
  return rel.startsWith('..') || isAbsolute(rel) ? path : join(shareRoot, rel)
}
fsMocks.nativeRealpath.mockImplementation(toShare)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Authorization reads only these catalog and settings methods; an empty catalog leaves session grants as the only way in.
const emptyStore = {
  getRepos: (): Repo[] => [],
  getProjectGroups: (): ProjectGroup[] => [],
  getFolderWorkspaces: (): FolderWorkspace[] => [],
  getSettings: (): { workspaceDir?: string } => ({})
} as Store

describe('external path grants on a drive the native realpath resolves elsewhere', () => {
  it('lets a granted file on a mapped drive pass the read check', async () => {
    const file = join(mappedDrive, 'docs', 'page-1.png')
    authorizeExternalPath(file)

    await expect(resolveAuthorizedPath(file, emptyStore)).resolves.toBe(
      join(shareRoot, 'docs', 'page-1.png')
    )
  })

  it('lets files under a granted mapped-drive folder pass the read check', async () => {
    authorizeExternalPath(join(mappedDrive, 'notes'))

    await expect(
      resolveAuthorizedPath(join(mappedDrive, 'notes', 'todo.md'), emptyStore)
    ).resolves.toBe(join(shareRoot, 'notes', 'todo.md'))
  })

  it('does not wait on the native realpath once the JS one has failed', () => {
    fsMocks.jsRealpath.mockImplementationOnce(() => {
      throw new Error('network path not found')
    })
    fsMocks.nativeRealpath.mockClear()

    authorizeExternalPath(join(mappedDrive, 'offline', 'report.pdf'))

    expect(fsMocks.nativeRealpath).not.toHaveBeenCalled()
  })

  it('does not extend a file grant to its siblings', async () => {
    authorizeExternalPath(join(mappedDrive, 'private', 'shared.png'))

    await expect(
      resolveAuthorizedPath(join(mappedDrive, 'private', 'secret.txt'), emptyStore)
    ).rejects.toThrow(PATH_ACCESS_DENIED_MESSAGE)
  })
})
