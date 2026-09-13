import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PLUGIN_LANGUAGE_PACK_MAX_BYTES } from '../../src/main/plugins/plugin-artifact-validation.ts'
import {
  PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH as HOST_MAX_DEPTH,
  PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES as HOST_MAX_ENTRIES,
  PLUGIN_LANGUAGE_CATALOG_MAX_KEY_LENGTH as HOST_MAX_KEY_LENGTH,
  PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH as HOST_MAX_VALUE_LENGTH,
  parsePluginLanguagePackArtifact
} from '../../src/shared/plugins/plugin-language-pack-artifact.ts'
import { isSafePluginId } from '../../src/shared/plugins/plugin-id-format.ts'
import { parsePluginManifest } from '../../src/shared/plugins/plugin-manifest.ts'
import { isReservedPluginIdentity } from '../../src/shared/plugins/plugin-marketplace.ts'
import { translatablePluginChromePaths } from '../../src/shared/plugins/plugin-translatable-chrome.ts'
import { isPluginUiLanguage } from '../../src/shared/ui-language.ts'
import { collectStringLeaves } from './locale-translation-policy.mjs'
import {
  PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH,
  PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES,
  PLUGIN_LANGUAGE_CATALOG_MAX_KEY_LENGTH,
  PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH,
  PLUGIN_LANGUAGE_PACK_MAX_BYTES as SCAFFOLD_MAX_BYTES,
  deleteNestedLeaf,
  protectedContainerFromLanguagePacks,
  protectedFromLanguagePacks
} from './scaffold-language-pack-catalog.mjs'
import { ENGINE_RE, ID_RE, PERSISTED_LANGUAGE_RE, main } from './scaffold-language-pack.mjs'

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function makePack(root, catalog, source, locale = 'es') {
  const pack = path.join(root, 'pack')
  writeJson(path.join(root, 'en.json'), source)
  writeJson(path.join(pack, 'orca-plugin.json'), {
    contributes: { languagePacks: [{ locale, path: `locales/${locale}.json` }] }
  })
  writeJson(path.join(pack, 'locales', `${locale}.json`), catalog)
  return pack
}

function manifestWithEngine(engine) {
  return {
    manifestVersion: 1,
    id: 'turkish',
    publisher: 'example',
    name: 'Türkçe',
    version: '1.0.0',
    engines: { orca: engine },
    pluginApi: 1,
    contributes: { languagePacks: [] },
    capabilities: []
  }
}

async function withMutedConsole(run) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    return await run({ log, error })
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

describe('scaffold-language-pack', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'orca-language-pack-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('init writes a valid manifest and empty catalog and refuses a non-empty output', async () => {
    const out = path.join(root, 'turkish')
    const result = await withMutedConsole(() =>
      main(root, [
        'init',
        '--locale',
        'tr',
        '--publisher',
        'example',
        '--id',
        'turkish',
        '--out',
        out
      ])
    )

    expect(result).toBe(0)
    expect(parsePluginManifest(readJson(path.join(out, 'orca-plugin.json'))).ok).toBe(true)
    expect(readJson(path.join(out, 'locales', 'tr.json'))).toEqual({})
    writeFileSync(path.join(out, 'keep.txt'), 'keep', 'utf8')
    await expect(
      withMutedConsole(() =>
        main(root, [
          'init',
          '--locale',
          'tr',
          '--publisher',
          'example',
          '--id',
          'turkish',
          '--out',
          out
        ])
      )
    ).resolves.toBe(1)
  })

  it('init rejects invalid or reserved identity, locale and engine values', async () => {
    const base = ['init', '--locale', 'tr', '--publisher', 'example', '--id', 'turkish', '--out']
    const runs = [
      [...base, path.join(root, 'bad-id'), '--id', 'Bad'],
      [...base, path.join(root, 'bad-publisher'), '--publisher', '__proto__'],
      [...base, path.join(root, 'reserved-id'), '--id', 'orca-turkish'],
      [...base, path.join(root, 'reserved-publisher'), '--publisher', 'stablyai'],
      [...base, path.join(root, 'device-locale'), '--locale', 'con'],
      [...base, path.join(root, 'long-name'), '--name', 'n'.repeat(257)],
      [...base, path.join(root, 'long-description'), '--description', 'd'.repeat(4097)],
      [...base, path.join(root, 'bad-locale'), '--locale', 'en_XX'],
      [...base, path.join(root, 'bad-engines'), '--engines', '^1.4.0'],
      [...base, path.join(root, 'long-engines'), '--engines', `>=${'1'.repeat(61)}.0.0`]
    ]
    for (const argv of runs) {
      await expect(withMutedConsole(() => main(root, argv))).resolves.toBe(1)
    }
  })

  it('pins identity, locale, engine and reserved-identity behavior to the host', async () => {
    const dangerousIds = new Set(['__proto__', 'prototype', 'constructor'])
    for (const id of ['turkish', 'orca-x', 'Bad', 'a--b', '__proto__', 'a'.repeat(65)]) {
      expect(ID_RE.test(id) && id.length <= 64 && !dangerousIds.has(id)).toBe(isSafePluginId(id))
    }
    for (const language of [
      'plugin:example.turkish/tr',
      'plugin:example.turkish/pt-BR',
      'plugin:Bad.turkish/tr',
      'plugin:example.turkish/en_US',
      'tr'
    ]) {
      expect(PERSISTED_LANGUAGE_RE.test(language)).toBe(isPluginUiLanguage(language))
    }
    for (const engine of ['>=1.4.0', '^1.4.0', `>=${'1'.repeat(61)}.0.0`]) {
      expect(parsePluginManifest(manifestWithEngine(engine)).ok).toBe(
        ENGINE_RE.test(engine) && engine.length <= 64
      )
    }
    for (const [publisher, id] of [
      ['example', 'orca-turkish'],
      ['stablyai', 'turkish']
    ]) {
      expect(isReservedPluginIdentity(`${publisher}.${id}`)).toBe(true)
      await expect(
        withMutedConsole(() =>
          main(root, [
            'init',
            '--locale',
            'tr',
            '--publisher',
            publisher,
            '--id',
            id,
            '--out',
            path.join(root, `${publisher}-${id}`)
          ])
        )
      ).resolves.toBe(1)
    }
  })

  it('status calculates coverage from required translatable values only', async () => {
    const protectedKey = 'auto.components.settings.PluginConsentDialog.title'
    const source = {
      normal: {
        translated: 'Hello {{name}}',
        copied: 'Copy me',
        absent: 'Missing',
        url: 'https://example.com',
        huge: 'x'.repeat(8193)
      },
      auto: { components: { settings: { PluginConsentDialog: { title: 'Protected' } } } }
    }
    const pack = makePack(
      root,
      { normal: { translated: 'Hola {{name}}', copied: 'Copy me' } },
      source
    )

    await withMutedConsole(async ({ log }) => {
      expect(await main(root, ['status', '--pack', pack, '--source', 'en.json'])).toBe(0)
      expect(log).toHaveBeenCalledWith(
        'Language pack es: 1/3 required keys (33.3% coverage), 1 missing, 0 retired, 1 copied English.'
      )
    })
    expect(protectedFromLanguagePacks(protectedKey)).toBe(true)
  })

  it('status check rejects host-invalid findings but accepts an incomplete pack', async () => {
    const source = {
      greeting: 'Hello {{name}}',
      auto: { components: { settings: { PluginConsentDialog: { title: 'Protected' } } } }
    }
    const cases = [
      { auto: { components: { settings: { PluginConsentDialog: { title: 'Bad' } } } } },
      { greeting: 'Hola {{wrong}}' },
      { 'bad.key': 'Bad' },
      { greeting: 42 }
    ]
    for (const [index, catalog] of cases.entries()) {
      const caseRoot = path.join(root, String(index))
      mkdirSync(caseRoot)
      const pack = makePack(caseRoot, catalog, source)
      await expect(
        withMutedConsole(() =>
          main(caseRoot, ['status', '--pack', pack, '--source', 'en.json', '--check'])
        )
      ).resolves.toBe(1)
    }
    const incompleteRoot = path.join(root, 'incomplete')
    mkdirSync(incompleteRoot)
    const incomplete = makePack(incompleteRoot, {}, source)
    await expect(
      withMutedConsole(() =>
        main(incompleteRoot, ['status', '--pack', incomplete, '--source', 'en.json', '--check'])
      )
    ).resolves.toBe(0)
  })

  it('status fix removes unsafe entries and keeps mismatched placeholders deterministically', async () => {
    const source = {
      zed: 'Zed',
      greeting: 'Hello {{name}}',
      alpha: 'Alpha',
      auto: { components: { settings: { PluginConsentDialog: { title: 'Protected' } } } }
    }
    const pack = makePack(
      root,
      {
        retired: 'Old',
        zed: 'z'.repeat(8193),
        greeting: 'Hola {{wrong}}',
        alpha: 'Alfa',
        auto: { components: { settings: { PluginConsentDialog: { title: 'Bad' } } } }
      },
      source
    )
    const argv = ['status', '--pack', pack, '--source', 'en.json', '--fix']

    await expect(withMutedConsole(() => main(root, argv))).resolves.toBe(0)
    const catalogPath = path.join(pack, 'locales', 'es.json')
    const first = readFileSync(catalogPath, 'utf8')
    expect(first).toBe('{\n  "alpha": "Alfa",\n  "greeting": "Hola {{wrong}}"\n}\n')
    await expect(withMutedConsole(() => main(root, argv))).resolves.toBe(0)
    expect(readFileSync(catalogPath, 'utf8')).toBe(first)
  })

  it('export missing writes only nested required gaps and requires overwrite permission', async () => {
    const source = {
      section: { present: 'Present', missing: 'Missing', url: 'https://example.com' },
      auto: { components: { settings: { PluginConsentDialog: { title: 'Protected' } } } }
    }
    const pack = makePack(root, { section: { present: 'Presente' } }, source)
    const out = path.join(root, 'missing.json')
    const argv = ['export-missing', '--pack', pack, '--source', 'en.json', '--out', out]

    await expect(withMutedConsole(() => main(root, argv))).resolves.toBe(0)
    expect(readJson(out)).toEqual({ section: { missing: 'Missing' } })
    await expect(withMutedConsole(() => main(root, argv))).resolves.toBe(1)
    await expect(withMutedConsole(() => main(root, [...argv, '--overwrite']))).resolves.toBe(0)
  })

  it('merge validates translations and preserves existing values unless overwrite is requested', async () => {
    const source = {
      existing: 'Existing',
      good: 'Good',
      copied: 'Copied',
      empty: 'Empty',
      greeting: 'Hello {{name}}',
      auto: { components: { settings: { PluginConsentDialog: { title: 'Protected' } } } }
    }
    const pack = makePack(root, { existing: 'Existente' }, source)
    const incoming = path.join(root, 'incoming.json')
    writeJson(incoming, {
      existing: 'Nuevo',
      good: 'Bueno',
      copied: 'Copied',
      empty: '   ',
      greeting: 'Hola {{wrong}}',
      auto: { components: { settings: { PluginConsentDialog: { title: 'Bad' } } } }
    })
    const argv = ['merge', '--pack', pack, '--source', 'en.json', '--from', incoming]

    await expect(withMutedConsole(() => main(root, argv))).resolves.toBe(1)
    expect(readJson(path.join(pack, 'locales', 'es.json'))).toEqual({
      existing: 'Existente',
      good: 'Bueno'
    })
    await expect(withMutedConsole(() => main(root, [...argv, '--overwrite']))).resolves.toBe(1)
    expect(readJson(path.join(pack, 'locales', 'es.json')).existing).toBe('Nuevo')
  })

  it('pins chrome protection behavior and host catalog limits', () => {
    for (const chromePath of translatablePluginChromePaths()) {
      expect(protectedFromLanguagePacks(chromePath)).toBe(false)
    }
    expect(protectedFromLanguagePacks('auto.components.settings.PluginConsentDialog.title')).toBe(
      true
    )
    expect(
      protectedContainerFromLanguagePacks('auto.components.settings.PluginMarketplaceBrowser')
    ).toBe(false)
    expect(
      protectedContainerFromLanguagePacks('auto.components.settings.PluginConsentDialog')
    ).toBe(true)
    expect(PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES).toBe(HOST_MAX_ENTRIES)
    expect(PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH).toBe(HOST_MAX_DEPTH)
    expect(PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH).toBe(HOST_MAX_VALUE_LENGTH)
    expect(PLUGIN_LANGUAGE_CATALOG_MAX_KEY_LENGTH).toBe(HOST_MAX_KEY_LENGTH)
    expect(SCAFFOLD_MAX_BYTES).toBe(PLUGIN_LANGUAGE_PACK_MAX_BYTES)
  })

  it('rejects a catalog path that escapes the pack', async () => {
    const pack = makePack(root, {}, { greeting: 'Hello' })
    const manifestPath = path.join(pack, 'orca-plugin.json')
    const manifest = readJson(manifestPath)
    manifest.contributes.languagePacks[0].path = '../evil.json'
    writeJson(manifestPath, manifest)
    await expect(
      withMutedConsole(() => main(root, ['status', '--pack', pack, '--source', 'en.json']))
    ).resolves.toBe(1)
  })

  it('rejects a catalog symlink escape without changing the outside file', async () => {
    const pack = path.join(root, 'pack')
    const outside = path.join(root, 'outside')
    writeJson(path.join(root, 'en.json'), { greeting: 'Hello' })
    writeJson(path.join(outside, 'es.json'), { retired: 'Outside' })
    writeJson(path.join(pack, 'orca-plugin.json'), {
      contributes: { languagePacks: [{ locale: 'es', path: 'locales/es.json' }] }
    })
    try {
      symlinkSync(outside, path.join(pack, 'locales'), 'dir')
    } catch {
      // Why: some Windows test environments do not grant symlink creation privileges.
      return
    }
    const outsidePath = path.join(outside, 'es.json')
    const before = readFileSync(outsidePath, 'utf8')
    await expect(
      withMutedConsole(() => main(root, ['status', '--pack', pack, '--source', 'en.json']))
    ).resolves.toBe(1)
    await expect(
      withMutedConsole(() => main(root, ['status', '--pack', pack, '--source', 'en.json', '--fix']))
    ).resolves.toBe(1)
    expect(readFileSync(outsidePath, 'utf8')).toBe(before)
  })

  it('rejects a malformed English source without prototype pollution', async () => {
    const pack = makePack(root, {}, {})
    writeFileSync(
      path.join(root, 'malicious-en.json'),
      '{"foo":{"__proto__":{"title":"POLLUTED"}}}\n',
      'utf8'
    )
    await expect(
      withMutedConsole(() =>
        main(root, [
          'export-missing',
          '--pack',
          pack,
          '--source',
          'malicious-en.json',
          '--out',
          'missing.json'
        ])
      )
    ).resolves.toBe(1)
    expect(() => deleteNestedLeaf({}, 'foo.constructor.title')).toThrow('unsafe catalog path')
    expect({}.title).toBeUndefined()
  })

  it('detects and fixes a protected empty container', async () => {
    const protectedCatalog = {
      auto: { components: { settings: { PluginConsentDialog: {} } } }
    }
    const pack = makePack(root, protectedCatalog, protectedCatalog)
    const argv = ['status', '--pack', pack, '--source', 'en.json', '--check']
    await expect(withMutedConsole(() => main(root, argv))).resolves.toBe(1)
    await expect(withMutedConsole(() => main(root, [...argv, '--fix']))).resolves.toBe(0)
    expect(readJson(path.join(pack, 'locales', 'es.json'))).toEqual({})
  })

  it('does not write a merged catalog that exceeds the host node limit', async () => {
    const source = {}
    const catalog = {}
    const incoming = {}
    for (let index = 0; index < 10_000; index += 1) {
      source[`known${index}`] = `English ${index}`
      incoming[`known${index}`] = `Translated ${index}`
    }
    for (let index = 0; index < 10_001; index += 1) {
      catalog[`retired${index}`] = `Retired ${index}`
    }
    const pack = makePack(root, catalog, source)
    const incomingPath = path.join(root, 'incoming-limit.json')
    writeJson(incomingPath, incoming)
    const catalogPath = path.join(pack, 'locales', 'es.json')
    const before = readFileSync(catalogPath)
    await expect(
      withMutedConsole(() =>
        main(root, ['merge', '--pack', pack, '--source', 'en.json', '--from', incomingPath])
      )
    ).resolves.toBe(1)
    expect(readFileSync(catalogPath)).toEqual(before)
  })

  it('exports a host-valid missing catalog from the real English catalog', async () => {
    const pack = path.join(root, 'real-pack')
    const missing = path.join(root, 'real-missing.json')
    await expect(
      withMutedConsole(() =>
        main(process.cwd(), [
          'init',
          '--locale',
          'tr',
          '--publisher',
          'example',
          '--id',
          'turkish',
          '--out',
          pack
        ])
      )
    ).resolves.toBe(0)
    await expect(
      withMutedConsole(() =>
        main(process.cwd(), ['export-missing', '--pack', pack, '--out', missing])
      )
    ).resolves.toBe(0)

    const raw = readFileSync(missing, 'utf8')
    expect(parsePluginLanguagePackArtifact(raw).ok).toBe(true)
    for (const { key, value } of collectStringLeaves(JSON.parse(raw))) {
      expect(protectedFromLanguagePacks(key)).toBe(false)
      expect(value.length).toBeLessThanOrEqual(8192)
    }
    expect(existsSync(missing)).toBe(true)
    await expect(
      withMutedConsole(() => main(process.cwd(), ['status', '--pack', pack, '--check']))
    ).resolves.toBe(0)
  })
})
