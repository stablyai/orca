import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  collectLocalizationReferences,
  main as verifyLocalizationCatalog
} from './verify-localization-catalog.mjs'
import { collectRuntimeRequiredKeys } from './generate-runtime-required-english-catalog.mjs'

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
  it('reuses imported readonly string defaults without shipping duplicate boot entries', async () => {
    const { root } = makeProject({
      sourceText: `import { COPY as defaults } from './copy'
translate('test.literal', defaults.literal)
translate('test.dynamic', defaults.dynamic)
function shadow(defaults) { return translate('test.shadow', defaults.literal) }
`
    })
    const componentDir = path.join(root, 'src/renderer/src/components')
    writeFileSync(
      path.join(componentDir, 'copy.ts'),
      `export const COPY = {
  literal: 'Literal default', dynamic: computeDefault()
} as const`
    )
    // A nested binding makes the import ambiguous; keep all such defaults in the boot catalog.
    let references = await collectLocalizationReferences(root)
    expect(
      references
        .filter((reference) => reference.key.startsWith('test.'))
        .every((reference) => reference.fallback === undefined)
    ).toBe(true)
    writeFileSync(
      path.join(componentDir, 'Example.tsx'),
      `import { COPY as defaults } from './copy'
translate('test.literal', defaults.literal)
translate('test.dynamic', defaults.dynamic)
`
    )
    references = await collectLocalizationReferences(root)
    expect(
      collectRuntimeRequiredKeys(
        new Map([
          ['test.literal', 'Literal default'],
          ['test.dynamic', 'Runtime default']
        ]),
        references
      )
    ).toEqual(new Set(['test.dynamic']))
    writeFileSync(
      path.join(componentDir, 'copy.ts'),
      `export const COPY = { literal: 'Changed default' } as const`
    )
    references = await collectLocalizationReferences(root)
    expect(
      collectRuntimeRequiredKeys(new Map([['test.literal', 'Literal default']]), references)
    ).toEqual(new Set(['test.literal']))
  })

  it('bootstraps English entries without fabricating target translations', async () => {
    const { root, localesDir } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('auto.example.greeting', 'Hello {{name}}', { name: 'Orca' })\n"
    })

    await expect(verifyLocalizationCatalog(root, { fix: false })).resolves.toBe(1)
    await expect(verifyLocalizationCatalog(root, { fix: true })).resolves.toBe(0)

    expect(readJson(path.join(localesDir, 'en.json'))).toEqual({
      auto: { example: { greeting: 'Hello {{name}}' } }
    })
    expect(readJson(path.join(localesDir, 'es.json'))).toEqual({})
  })

  it.each([
    ['en', false],
    ['en', true],
    ['es', false]
  ])('rejects dotted %s keys without rewriting them (fix: %s)', async (locale, fix) => {
    const nested = { auto: { example: { greeting: 'Hello.world' } } }
    const { root, localesDir } = makeProject({
      sourceText: 'export {}\n',
      enCatalog: locale === 'en' ? { 'auto.example.greeting': 'Hello.world' } : nested,
      esCatalog: locale === 'es' ? { auto: { 'example.greeting': 'Hola.world' } } : {}
    })
    const catalogPath = path.join(localesDir, `${locale}.json`)
    const before = readFileSync(catalogPath, 'utf8')
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(verifyLocalizationCatalog(root, { fix })).resolves.toBe(1)
      expect(report).toHaveBeenCalledWith(expect.stringContaining(`${locale}.json`))
      expect(report).toHaveBeenCalledWith('dotted: auto.example.greeting')
      expect(readFileSync(catalogPath, 'utf8')).toBe(before)
    } finally {
      report.mockRestore()
    }
  })

  it('never overwrites mismatched translations or removes target-only entries', async () => {
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

    await expect(verifyLocalizationCatalog(root, { fix: true })).resolves.toBe(1)

    expect(readJson(path.join(localesDir, 'es.json'))).toEqual({
      auto: {
        example: { greeting: 'Hola' },
        stale: { removed: 'Viejo' }
      }
    })
  })

  it('refuses to --fix a missing key reused for two different sentences', async () => {
    const { root, localesDir } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const left = translate('auto.example.move', 'Move left')\nexport const right = translate('auto.example.move', 'Move right')\n"
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(verifyLocalizationCatalog(root, { fix: true })).resolves.toBe(1)
    expect(readJson(path.join(localesDir, 'en.json'))).toEqual({})
    expect(error.mock.calls.flat().join('\n')).toContain('auto.example.move')
    error.mockRestore()
    log.mockRestore()
  })

  it('does not invent values for keys without string fallbacks', async () => {
    const { root, localesDir } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('auto.example.noFallback')\n"
    })

    await expect(verifyLocalizationCatalog(root, { fix: true })).resolves.toBe(1)
    expect(readJson(path.join(localesDir, 'en.json'))).toEqual({})
  })

  it('fails when a target catalog repeats a key', async () => {
    const { root, localesDir } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('auto.example.greeting', 'Hello')\n",
      enCatalog: { auto: { example: { greeting: 'Hello' } } }
    })
    writeFileSync(
      path.join(localesDir, 'es.json'),
      '{\n  "auto": {\n    "example": {\n      "greeting": "Hola",\n      "greeting": "Hola"\n    }\n  }\n}\n',
      'utf8'
    )
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(verifyLocalizationCatalog(root, { fix: false })).resolves.toBe(1)
      expect(report).toHaveBeenCalledWith('- es.json:5 auto.example.greeting')
    } finally {
      report.mockRestore()
    }
  })
})
