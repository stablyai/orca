import type * as NodeFsPromises from 'node:fs/promises'
import type * as NodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repo-types'

// Resolve as Windows does, so the UNC authorization path runs on any host.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual.win32, default: actual.win32, win32: actual.win32, posix: actual.posix }
})

const touched = vi.hoisted((): string[] => [])
const existing = vi.hoisted(() => new Set<string>())
const fsMock = vi.hoisted(() => {
  // WSL 2.7 answers EPERM for any Windows access to a drive mount over UNC.
  const access = (target: string): void => {
    touched.push(target)
    if (target.startsWith('\\\\')) {
      throw Object.assign(new Error(`EPERM: operation not permitted, '${target}'`), {
        code: 'EPERM'
      })
    }
    if (!existing.has(target)) {
      throw Object.assign(new Error(`ENOENT: no such file, '${target}'`), { code: 'ENOENT' })
    }
  }
  return {
    realpath: vi.fn(async (target: string) => {
      access(target)
      return target
    }),
    lstat: vi.fn(async (target: string) => {
      access(target)
      return { isSymbolicLink: () => false }
    })
  }
})
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  ...fsMock
}))
vi.mock('../../repo-worktrees', () => ({ listRepoWorktreeGraph: vi.fn(async () => []) }))

import { resolveAuthorizedPath } from './filesystem-auth'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const originalPlatform = process.platform

function storeFor(path: string): Store {
  const repo: Repo = {
    id: 'repo',
    path,
    displayName: 'app',
    badgeColor: '',
    addedAt: 0,
    kind: 'git'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Authorization reads only these accessors.
  return {
    getRepos: () => [repo],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

describe('authorizing a new path in a UNC drive-mount project', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    invalidateAuthorizedRootsCache()
    touched.length = 0
    existing.clear()
    existing.add(String.raw`C:\src\app`)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('walks up through the drive path, so New File, New Folder and first saves are allowed', async () => {
    const store = storeFor(UNC)
    for (const target of [`${UNC}\\new.txt`, `${UNC}\\new-folder\\nested\\file.ts`]) {
      await expect(resolveAuthorizedPath(target, store)).resolves.toBe(target)
    }
    expect(touched.filter((target) => target.startsWith('\\\\'))).toEqual([])
  })
})
