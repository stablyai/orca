import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sweepExpiredOwnedDirectories } from './owned-temp-staging-root'

it('keeps a bounded sweep incomplete until the remaining owned directories are visited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-staging-sweep-'))
  try {
    for (const name of ['one', 'two', 'three']) {
      const path = join(root, name)
      await mkdir(path, { mode: 0o700 })
      await utimes(path, 0, 0)
    }
    const options = { nowMs: 100_000, ttlMs: 1_000, ownsEntry: () => true, entryLimit: 2 }
    expect(await sweepExpiredOwnedDirectories(root, options)).toEqual({
      complete: false,
      hasFailures: false,
      hasFreshDirectories: false
    })
    expect(await readdir(root)).toHaveLength(1)
    expect(await sweepExpiredOwnedDirectories(root, options)).toEqual({
      complete: true,
      hasFailures: false,
      hasFreshDirectories: false
    })
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
