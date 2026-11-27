import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeSkillTarGzip } from './skill-package-tar'

it('rejects an output failure while the source is still streaming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-tar-write-'))
  try {
    const source = join(root, 'source.txt')
    const destination = join(root, 'existing.tar.gz')
    await writeFile(source, 'x'.repeat(1024 * 1024))
    await writeFile(destination, 'original')
    await expect(
      writeSkillTarGzip(destination, [
        { path: 'source.txt', size: 1024 * 1024, executable: false, sourcePath: source }
      ])
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(destination, 'utf8')).toBe('original')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
