import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { main as verifyLocalizationRepair } from './verify-localization-repair.mjs'

function writeCatalogFixture(root, { en, ko }) {
  const dir = path.join(root, 'src', 'renderer', 'src', 'i18n', 'locales')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'en.json'), `${JSON.stringify(en, null, 2)}\n`)
  writeFileSync(path.join(dir, 'ko.json'), `${JSON.stringify(ko, null, 2)}\n`)
  // ja/zh required only when verifying defaults; fixture tests pass --locale via argv simulation
}

describe('verify-localization-repair', () => {
  it('passes when the catalog already matches the repair policy', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-localization-repair-'))
    writeCatalogFixture(root, {
      en: { a: { label: 'Delete Worktree' } },
      ko: { a: { label: '워크트리 삭제' } }
    })
    // main(root, locales) — second arg overrides argv parsing
    await expect(verifyLocalizationRepair(root, ['ko'])).resolves.toBe(0)
  })

  it('fails when a glossary-owned term has drifted', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-localization-repair-'))
    writeCatalogFixture(root, {
      en: { a: { label: 'Remove workspace' } },
      ko: { a: { label: '워크트리 제거' } }
    })
    await expect(verifyLocalizationRepair(root, ['ko'])).resolves.toBe(1)
  })
})
