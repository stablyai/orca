import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { reclaimRuntimeReleases } from './managed-runtime-release'

it('removes every release and leftover but the kept one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-runtime-reclaim-'))
  await Promise.all(['1.0', '0.9', '.download-1-left'].map((name) => mkdir(join(root, name))))
  expect(await reclaimRuntimeReleases(root, '1.0')).toEqual([])
  expect(await readdir(root)).toEqual(['1.0'])
  await rm(root, { recursive: true, force: true })
})
