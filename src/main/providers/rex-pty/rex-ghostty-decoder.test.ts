import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRexGhosttySnapshot } from './rex-ghostty-decoder'
import { createRexSnapshotDecoder } from './rex-snapshot-worker'

describe('Rex verified decoder', () => {
  it('rejects unapproved WASM bytes before compilation', async () => {
    await expect(
      decodeRexGhosttySnapshot(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.alloc(20))
    ).rejects.toThrow('Unapproved')
  })
  it('requires explicit absolute artifact paths', () => {
    expect(() => createRexSnapshotDecoder('ghostty.wasm', 'worker.js')).toThrow('Absolute')
  })
  it.skipIf(process.platform === 'win32')(
    'refuses missing, symlinked and unapproved artifacts before a spawn',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rex-artifact-'))
      try {
        const path = join(dir, 'ghostty.wasm')
        const decoder = createRexSnapshotDecoder(path, join(dir, 'worker.js'))
        await expect(decoder.validateArtifact!()).rejects.toThrow()
        await writeFile(path, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
        await expect(decoder.validateArtifact!()).rejects.toThrow('Unapproved')
        const alias = join(dir, 'alias')
        await symlink(path, alias)
        await expect(
          createRexSnapshotDecoder(alias, join(dir, 'worker.js')).validateArtifact!()
        ).rejects.toThrow()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})
