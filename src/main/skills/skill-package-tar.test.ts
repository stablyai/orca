import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openSkillTarGzip, SKILL_TAR_BLOCK_BYTES, writeSkillTarGzip } from './skill-package-tar'

describe('skill tar reader error ownership', () => {
  it('observes an abort after the pipeline completes before the first reader request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-tar-abort-'))
    try {
      const archivePath = join(root, 'archive.tar.gz')
      await writeSkillTarGzip(archivePath, [
        { path: 'SKILL.md', size: 1, executable: false, bytes: Buffer.from('x') }
      ])
      const archive = await openSkillTarGzip(archivePath)
      await archive.archiveIdentity
      const failure = Object.assign(new Error('staging directory already exists'), {
        code: 'EEXIST'
      })
      archive.abort(failure)
      // Observe destruction before lazily attaching the reader's error listener.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await expect(archive.reader.readExact(SKILL_TAR_BLOCK_BYTES)).rejects.toBe(failure)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
