import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './audit-localization-coverage.mjs'

describe('native dialog localization coverage', () => {
  it('fails the opt-in check for a new native dialog literal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-localization-'))
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'dialog.ts'), "const options = { detail: 'Raw detail' }")
      await writeFile(join(root, 'allowlist.json'), '[]')
      await expect(
        main(root, [
          '--check',
          '--native-dialog-fields',
          '--source-root',
          'src',
          '--allowlist',
          'allowlist.json'
        ])
      ).resolves.toBe(1)
    } finally {
      report.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
