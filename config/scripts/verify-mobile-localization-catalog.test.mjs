import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { main as verifyMobileCatalog } from './verify-mobile-localization-catalog.mjs'

const LOCALES = ['en', 'es', 'ja', 'ko', 'zh']

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function makeProject({ sourceText, catalogs }) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-mobile-localization-'))
  const appDirectory = path.join(root, 'mobile', 'app')
  const sourceDirectory = path.join(root, 'mobile', 'src')
  const localeDirectory = path.join(sourceDirectory, 'i18n', 'locales')
  mkdirSync(appDirectory, { recursive: true })
  mkdirSync(localeDirectory, { recursive: true })
  writeFileSync(path.join(appDirectory, 'Example.tsx'), sourceText, 'utf8')

  for (const locale of LOCALES) {
    writeJson(path.join(localeDirectory, `${locale}.json`), catalogs?.[locale] ?? catalogs.en)
  }
  return root
}

async function runFailedVerification(root) {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    await expect(verifyMobileCatalog(root)).resolves.toBe(1)
    return error.mock.calls.flat().join('\n')
  } finally {
    error.mockRestore()
  }
}

describe('verify-mobile-localization-catalog', () => {
  it('verifies literal and conditional keys with matching options', async () => {
    const catalog = { m: { greeting: 'Hello {{name}}', farewell: 'Bye {{name}}' } }
    const root = makeProject({
      sourceText:
        "import { t } from '@/i18n/mobile-i18n'\nconst name = 'Orca'\nexport const label = t(name ? 'm.greeting' : 'm.farewell', { name })\n",
      catalogs: { en: catalog }
    })

    await expect(verifyMobileCatalog(root)).resolves.toBe(0)
  })

  it('reports missing keys in conditional branches', async () => {
    const root = makeProject({
      sourceText:
        "import { t } from '@/i18n/mobile-i18n'\nexport const label = t(flag ? 'm.known' : 'm.missing')\n",
      catalogs: { en: { m: { known: 'Known' } } }
    })

    expect(await runFailedVerification(root)).toContain('missing English key: m.missing')
  })

  it('rejects translation keys that cannot be statically inspected', async () => {
    const root = makeProject({
      sourceText: "import { t } from '@/i18n/mobile-i18n'\nexport const label = t(runtimeKey)\n",
      catalogs: { en: { m: { known: 'Known' } } }
    })

    expect(await runFailedVerification(root)).toContain('not statically inspectable')
  })

  it('requires call options to exactly match English placeholders', async () => {
    const root = makeProject({
      sourceText:
        "import { t } from '@/i18n/mobile-i18n'\nexport const label = t('m.greeting', { value: 'Orca' })\n",
      catalogs: { en: { m: { greeting: 'Hello {{name}}' } } }
    })

    const report = await runFailedVerification(root)
    expect(report).toContain('options [value]')
    expect(report).toContain('placeholders [name]')
  })

  it('requires identical locale keys and placeholders', async () => {
    const en = { m: { greeting: 'Hello {{name}}' } }
    const root = makeProject({
      sourceText:
        "import { t } from '@/i18n/mobile-i18n'\nexport const label = t('m.greeting', { name: 'Orca' })\n",
      catalogs: {
        en,
        es: { m: { greeting: 'Hola {{wrongName}}', extra: 'Extra' } }
      }
    })

    const report = await runFailedVerification(root)
    expect(report).toContain('es.json placeholder mismatch: m.greeting')
    expect(report).toContain('es.json has extra key: m.extra')
  })

  it('rejects encoded HTML entities that React Native would render literally', async () => {
    const root = makeProject({
      sourceText: "export const label = 'not rendered'\n",
      catalogs: { en: { m: { label: 'Don&apos;t encode &amp; characters' } } }
    })

    expect(await runFailedVerification(root)).toContain(
      'en.json: m.label contains an encoded HTML entity'
    )
  })
})
