import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareTransientAgentImages,
  transientAgentImageDirectory
} from './agent-image-fit-storage'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
it.each([1, 10])(
  'expires %i old buckets including interrupted copies and keeps current copies',
  async (count) => {
    const temp = await mkdtemp(join(tmpdir(), 'orca-image-fit-storage-'))
    roots.push(temp)
    const now = Date.UTC(2026, 10, 19)
    const current = transientAgentImageDirectory(temp, now)
    await mkdir(current.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(current.directory, 'current.png'), 'current')
    for (let day = 1; day <= count; day++) {
      const bucket = join(current.root, `2026-10-${String(day).padStart(2, '0')}`)
      await mkdir(bucket, { mode: 0o700 })
      await writeFile(join(bucket, 'interrupted.png.part'), 'partial')
      await utimes(bucket, new Date(Date.UTC(2026, 9, day)), new Date(Date.UTC(2026, 9, day)))
    }
    await prepareTransientAgentImages(current.root, now)
    expect(await readdir(current.root)).toEqual(['2026-11-19'])
  }
)
