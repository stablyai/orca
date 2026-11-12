import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectLocalizationCandidates, main } from './audit-localization-coverage.mjs'

const path = '/repo/src/main/startup/dialog.ts'
const source = `
  const options = {
    message: translateMain('message', 'Translated message'),
    detail: 'Untranslated detail',
    buttons: ['Proceed', translateMain('cancel', 'Cancel')],
    body: 'Untranslated body',
    buttonLabel: 'Retry',
    checkboxLabel: 'Remember choice'
  }
`

describe('native dialog localization coverage', () => {
  it('finds untranslated native dialog fields while ignoring translated copy', () => {
    const candidates = collectLocalizationCandidates(path, source, '/repo', {
      includeNativeDialogFields: true
    })
    expect(candidates.map(({ kind, text }) => [kind, text])).toEqual([
      ['object-property:detail', 'Untranslated detail'],
      ['object-property:buttons', 'Proceed'],
      ['object-property:body', 'Untranslated body'],
      ['object-property:buttonLabel', 'Retry'],
      ['object-property:checkboxLabel', 'Remember choice']
    ])
  })

  it('does not change the existing renderer scan by default', () => {
    expect(collectLocalizationCandidates(path, source, '/repo')).toEqual([])
  })

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
