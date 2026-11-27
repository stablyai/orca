import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { promoteDownloadedFile } from './filesystem-download-promotion'

it('lets only one download claim an initially absent destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-download-claim-'))
  try {
    const first = join(root, 'first.download')
    const second = join(root, 'second.download')
    const destination = join(root, 'saved.txt')
    await Promise.all([writeFile(first, 'first download'), writeFile(second, 'second download')])
    const results = await Promise.allSettled([
      promoteDownloadedFile(first, destination, false),
      promoteDownloadedFile(second, destination, false)
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const remaining = (await readdir(root)).filter((name) => name.endsWith('.download'))
    expect(remaining).toHaveLength(1)
    expect(
      [
        await readFile(destination, 'utf8'),
        await readFile(join(root, remaining[0]!), 'utf8')
      ].sort()
    ).toEqual(['first download', 'second download'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
