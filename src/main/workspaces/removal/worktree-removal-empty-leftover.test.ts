import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const swap: { during: (() => void) | null } = vi.hoisted(() => ({ during: null }))
// Enumeration is the last read before deletion; a swap there is the window under test.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return {
    ...actual,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every overload's arguments to the real readdir unchanged.
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      swap.during?.()
      swap.during = null
      return actual.readdir(...args)
    }) as typeof actual.readdir
  }
})

import {
  assertUnregisteredLeftoverRemovable,
  removeEmptyLeftoverDirectory
} from './worktree-removal-leftover'

let dir: string | undefined
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})
function emptyRoot() {
  dir = mkdtempSync(join(tmpdir(), 'orca-empty-leftover-'))
  const root = join(dir, 'checkout')
  mkdirSync(root)
  const stats = lstatSync(root, { bigint: true })
  return { repo: join(dir, 'repo'), root, rootKey: `${stats.dev}:${stats.ino}` }
}
function replace(root: string) {
  renameSync(root, `${root}-moved`)
  mkdirSync(root)
}

it('removes the reviewed empty root', async () => {
  const { repo, root, rootKey } = emptyRoot()
  expect(await assertUnregisteredLeftoverRemovable(repo, root, [], rootKey)).toBe('empty')
  await removeEmptyLeftoverDirectory(root, rootKey)
  expect(existsSync(root)).toBe(false)
})

it('refuses an empty folder swapped in while the reviewed root was being enumerated', async () => {
  const { repo, root, rootKey } = emptyRoot()
  swap.during = () => replace(root)
  await expect(assertUnregisteredLeftoverRemovable(repo, root, [], rootKey)).rejects.toThrow()
  expect(existsSync(root)).toBe(true)
})

it('refuses an empty folder swapped in after the check, right before rmdir', async () => {
  const { repo, root, rootKey } = emptyRoot()
  expect(await assertUnregisteredLeftoverRemovable(repo, root, [], rootKey)).toBe('empty')
  replace(root)
  await expect(removeEmptyLeftoverDirectory(root, rootKey)).rejects.toThrow()
  expect(existsSync(root)).toBe(true)
})
