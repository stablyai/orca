import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { main as verifyLocalizationCatalog } from './verify-localization-catalog.mjs'

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function makeProject({ sourceText, enCatalog = {}, esCatalog = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-localization-catalog-'))
  const rendererDir = path.join(root, 'src', 'renderer', 'src', 'components')
  const mainDir = path.join(root, 'src', 'main')
  const localesDir = path.join(root, 'src', 'renderer', 'src', 'i18n', 'locales')

  mkdirSync(rendererDir, { recursive: true })
  mkdirSync(mainDir, { recursive: true })
  mkdirSync(localesDir, { recursive: true })

  writeFileSync(path.join(rendererDir, 'Example.tsx'), sourceText, 'utf8')
  writeFileSync(path.join(mainDir, 'empty.ts'), 'export {}\n', 'utf8')
  writeJson(path.join(localesDir, 'en.json'), enCatalog)
  writeJson(path.join(localesDir, 'es.json'), esCatalog)

  return { root, localesDir }
}

describe('verify-localization-catalog', () => {
  it('bootstraps missing catalog entries from string fallbacks', async () => {
    const { root, localesDir } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('auto.example.greeting', 'Hello {{name}}', { name: 'Orca' })\n"
    })

    await expect(verifyLocalizationCatalog(root, { fix: false })).resolves.toBe(1)
    await expect(verifyLocalizationCatalog(root, { fix: true })).resolves.toBe(0)

    expect(readJson(path.join(localesDir, 'en.json'))).toEqual({
      auto: { example: { greeting: 'Hello {{name}}' } }
    })
    expect(readJson(path.join(localesDir, 'es.json'))).toEqual({
      auto: { example: { greeting: 'Hello {{name}}' } }
    })
  })

  it('repairs stale locale keys and interpolation mismatches', async () => {
    const { root, localesDir } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('auto.example.greeting', 'Hello {{name}}', { name: 'Orca' })\n",
      enCatalog: { auto: { example: { greeting: 'Hello {{name}}' } } },
      esCatalog: {
        auto: {
          example: { greeting: 'Hola' },
          stale: { removed: 'Viejo' }
        }
      }
    })

    await expect(verifyLocalizationCatalog(root, { fix: true })).resolves.toBe(0)

    expect(readJson(path.join(localesDir, 'es.json'))).toEqual({
      auto: { example: { greeting: 'Hello {{name}}' } }
    })
  })

  it('does not invent values for keys without string fallbacks', async () => {
    const { root, localesDir } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('auto.example.noFallback')\n"
    })

    await expect(verifyLocalizationCatalog(root, { fix: true })).resolves.toBe(1)
    expect(readJson(path.join(localesDir, 'en.json'))).toEqual({})
  })

  it('reports partial plugin catalog gaps but rejects malformed interpolation', async () => {
    const { root } = makeProject({
      sourceText: 'export {}\n',
      enCatalog: {
        auto: { first: 'First {{name}}', second: 'Second' }
      },
      esCatalog: {
        auto: { first: 'Primero {{name}}', second: 'Segundo' }
      }
    })
    const pluginCatalogPath = path.join(root, 'plugin-locale.json')
    writeJson(pluginCatalogPath, {
      auto: { first: 'Primeiro {{wrongName}}', pluginOnly: 'Plugin only' }
    })
    const report = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await expect(
        verifyLocalizationCatalog(root, {
          fix: false,
          pluginCatalogs: [pluginCatalogPath]
        })
      ).resolves.toBe(1)
      expect(report).toHaveBeenCalledWith(expect.stringContaining('0/2 core keys'))
      expect(report).toHaveBeenCalledWith(expect.stringContaining('interpolation mismatch'))
    } finally {
      report.mockRestore()
    }
  })
})
