import { createHash } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { ModelManager } from './model-manager'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-speech-models-test'
  }
}))

type ModelManagerInternals = {
  verifyArchiveSha256: (archivePath: string, expectedSha256: string) => Promise<void>
  downloadFile: (
    url: string,
    dest: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean
  ) => Promise<void>
}

describe('ModelManager', () => {
  it('requires pinned SHA-256 hashes for every catalog archive', () => {
    for (const manifest of SPEECH_MODEL_CATALOG) {
      expect(manifest.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('verifies downloaded archive hashes before extraction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const archivePath = join(dir, 'model.tar.bz2')
      writeFileSync(archivePath, 'known archive bytes')
      const expected = createHash('sha256').update('known archive bytes').digest('hex')
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

      await expect(manager.verifyArchiveSha256(archivePath, expected)).resolves.toBeUndefined()
      await expect(manager.verifyArchiveSha256(archivePath, '0'.repeat(64))).rejects.toThrow(
        /integrity verification/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects non-HTTPS model downloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

      await expect(
        manager.downloadFile(
          'http://example.com/model.tar.bz2',
          join(dir, 'model.tar.bz2'),
          1,
          'm',
          () => false
        )
      ).rejects.toThrow(/HTTPS/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
