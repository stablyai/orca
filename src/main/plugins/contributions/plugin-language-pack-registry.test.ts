import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PluginContentVerifier } from '../plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { PluginLanguagePackRegistry } from './plugin-language-pack-registry'

const roots: string[] = []

async function pluginWithCatalog(catalog: unknown): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-language-registry-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'locales'))
  await writeFile(join(rootDir, 'locales', 'pt-BR.json'), JSON.stringify(catalog))
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'portuguese',
    publisher: 'samples',
    name: 'Portuguese',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      languagePacks: [{ locale: 'pt-BR', path: 'locales/pt-BR.json' }]
    },
    capabilities: []
  })
  return {
    pluginKey: 'samples.portuguese',
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginLanguagePackRegistry', () => {
  it('loads approved catalogs under an isolated plugin language id', async () => {
    const plugin = await pluginWithCatalog({ common: { save: 'Salvar' } })
    const registry = new PluginLanguagePackRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toEqual([
      {
        id: 'plugin:samples.portuguese/pt-BR',
        resourceLanguage: 'pt-BR-x-orcapk-73616d70-6c65732e-706f7274-75677565-73652f70-742d4252',
        pluginKey: 'samples.portuguese',
        locale: 'pt-BR',
        catalog: { common: { save: 'Salvar' } },
        // One string against the whole English catalog.
        coverage: 0
      }
    ])
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })

  it('loads a pack that covers protected security copy, leaving that copy in English', async () => {
    const plugin = await pluginWithCatalog({
      common: { save: 'Sávé' },
      auto: { components: { settings: { PluginConsentDialog: { disclaimer: 'Safe' } } } }
    })
    const registry = new PluginLanguagePackRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)
    expect(registry.error(plugin.pluginKey)).toBeNull()
    expect(registry.list()[0]?.catalog).toEqual({
      common: { save: 'Sávé' },
      auto: { components: { settings: {} } }
    })
  })
})
