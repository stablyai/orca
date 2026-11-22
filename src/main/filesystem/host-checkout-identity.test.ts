import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, rename, readFile, lstat } from 'node:fs/promises'
import * as identityFilesystem from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as filesystem from './asar-transparent-fs'
import { removeHostCheckout } from './host-tree-removal'
import {
  captureWorktreeCheckoutIdentity,
  assertWorktreeCheckoutIdentity
} from '../workspaces/removal/worktree-checkout-identity'
import { assertWorktreeCheckoutIdentityBeforeSpawn } from '../worker-thread-child-process/worktree-checkout-identity-guard'
import {
  WORKTREE_CHECKOUT_NONCE,
  WorktreeRemovalIncarnationChangedError
} from '../../shared/worktree/removal/worktree-checkout-identity'
import { failureLeftByGit } from '../workspaces/removal/worktree-removal-failure'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof identityFilesystem>())
}))

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-checkout-identity-'))
  roots.push(root)
  const checkout = join(root, 'checkout'),
    admin = join(root, 'repo', '.git', 'worktrees', 'A')
  const create = async (name: string) => {
    const gitDir = join(root, 'repo', '.git', 'worktrees', name)
    await mkdir(checkout, { recursive: true })
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(checkout, '.git'), `gitdir: ${gitDir}\n`)
    await writeFile(join(gitDir, 'gitdir'), `${join(checkout, '.git')}\n`)
    await writeFile(join(checkout, 'tracked'), name)
  }
  await create('A')
  const expected = await captureWorktreeCheckoutIdentity(checkout, 'A', join(root, 'repo'))
  return { root, checkout, admin, expected, create }
}
it('finishes an unchanged checkout walk after removing its own Git marker', async () => {
  const f = await fixture()
  assertWorktreeCheckoutIdentityBeforeSpawn({ identity: f.expected })
  await removeHostCheckout(
    f.checkout,
    async () => true,
    undefined,
    undefined,
    undefined,
    (markerGone) => assertWorktreeCheckoutIdentity(f.expected, markerGone)
  )
  expect(existsSync(f.checkout)).toBe(false)
})
it('keeps directory identity stable when a filesystem reports change time as birth time', async () => {
  const f = await fixture()
  const stats = await lstat(f.checkout, { bigint: true })
  const changed = Object.assign(stats, { birthtimeNs: stats.birthtimeNs + 1n })
  vi.spyOn(identityFilesystem, 'lstat').mockResolvedValueOnce(changed)
  await expect(assertWorktreeCheckoutIdentity(f.expected)).resolves.toBeUndefined()
})

it.each(['EIO', 'EACCES'])(
  'retains a retry after a post-deletion identity read fails with %s',
  async (code) => {
    const f = await fixture()
    await rm(join(f.checkout, '.git'))
    const readError = Object.assign(new Error('Identity read failed'), { code })
    vi.spyOn(identityFilesystem, 'lstat').mockRejectedValueOnce(readError)
    let failure: unknown
    try {
      await assertWorktreeCheckoutIdentity(f.expected, true)
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(readError)
    await expect(
      failureLeftByGit(
        {
          worktreeId: 'repo::checkout',
          repoId: 'repo',
          repoPath: join(f.root, 'repo'),
          worktreePath: f.checkout,
          branch: 'feature',
          head: 'abc',
          deleteBranch: false,
          force: false,
          requestedAt: 1
        },
        failure
      )
    ).resolves.toMatchObject({ message: 'Identity read failed' })
  }
)
it('refuses a recreated admin entry even when the checkout and Git pointer stay in place', async () => {
  const f = await fixture()
  await rm(f.admin, { recursive: true })
  await mkdir(f.admin, { recursive: true })
  await writeFile(join(f.admin, 'gitdir'), `${join(f.checkout, '.git')}\n`)
  await captureWorktreeCheckoutIdentity(f.checkout, 'B', join(f.root, 'repo'))
  expect(() => assertWorktreeCheckoutIdentityBeforeSpawn({ identity: f.expected })).toThrow(
    WorktreeRemovalIncarnationChangedError
  )
  await expect(assertWorktreeCheckoutIdentity(f.expected)).rejects.toThrow(
    WorktreeRemovalIncarnationChangedError
  )
  expect(await readFile(join(f.checkout, 'tracked'), 'utf8')).toBe('A')
})
it.each(['enumeration', 'marker-removal'] as const)(
  'preserves B installed after asynchronous %s in the Windows checkout walker',
  async (boundary) => {
    const f = await fixture()
    const replace = async () => {
      await rename(f.checkout, join(f.root, 'retired-A'))
      await f.create('B')
    }
    if (boundary === 'enumeration') {
      const enumerate = filesystem.readdir
      vi.spyOn(filesystem, 'readdir').mockImplementationOnce(async (path) => {
        const names = await enumerate(path)
        await replace()
        return names
      })
    } else {
      const unlink = filesystem.unlink
      vi.spyOn(filesystem, 'unlink').mockImplementationOnce(async (path) => {
        await unlink(path)
        await replace()
      })
    }
    await expect(
      removeHostCheckout(
        f.checkout,
        async () => true,
        undefined,
        undefined,
        undefined,
        (markerGone) => assertWorktreeCheckoutIdentity(f.expected, markerGone)
      )
    ).rejects.toThrow(WorktreeRemovalIncarnationChangedError)
    expect(await readFile(join(f.checkout, 'tracked'), 'utf8')).toBe('B')
    expect(existsSync(join(f.checkout, '.git'))).toBe(true)
  }
)

it('does not create a nonce outside the owning repository metadata', async () => {
  const f = await fixture()
  const foreign = join(f.root, 'foreign', '.git', 'worktrees', 'entry')
  await mkdir(foreign, { recursive: true })
  await writeFile(join(foreign, 'gitdir'), `${join(f.checkout, '.git')}\n`)
  await writeFile(join(f.checkout, '.git'), `gitdir: ${foreign}\n`)
  await expect(
    captureWorktreeCheckoutIdentity(f.checkout, 'A', join(f.root, 'repo'))
  ).rejects.toThrow(WorktreeRemovalIncarnationChangedError)
  expect(existsSync(join(foreign, WORKTREE_CHECKOUT_NONCE))).toBe(false)
})

it('refuses registration finalization when a replacement appears at the removed path', async () => {
  const f = await fixture()
  await rm(f.checkout, { recursive: true })
  const guard = { identity: f.expected, checkoutRemoved: true as const }
  assertWorktreeCheckoutIdentityBeforeSpawn(guard)
  await f.create('B')
  expect(() => assertWorktreeCheckoutIdentityBeforeSpawn(guard)).toThrow(
    WorktreeRemovalIncarnationChangedError
  )
  expect(await readFile(join(f.checkout, 'tracked'), 'utf8')).toBe('B')
})
it('does not admit a delayed successful check after another child detects replacement', async () => {
  const f = await fixture()
  await writeFile(join(f.checkout, 'other'), 'A')
  const verified = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let first = true
  const guard = async (markerGone: boolean) => {
    if (first) {
      first = false
      await assertWorktreeCheckoutIdentity(f.expected, markerGone)
      verified.resolve()
      await release.promise
      return
    }
    await verified.promise
    await rename(f.checkout, join(f.root, 'retired-A'))
    await f.create('B')
    await writeFile(join(f.checkout, 'other'), 'B')
    try {
      await assertWorktreeCheckoutIdentity(f.expected, markerGone)
    } finally {
      queueMicrotask(() => release.resolve())
    }
  }
  await expect(
    removeHostCheckout(f.checkout, async () => true, undefined, undefined, undefined, guard)
  ).rejects.toThrow(WorktreeRemovalIncarnationChangedError)
  expect(await readFile(join(f.checkout, 'tracked'), 'utf8')).toBe('B')
  expect(await readFile(join(f.checkout, 'other'), 'utf8')).toBe('B')
})
