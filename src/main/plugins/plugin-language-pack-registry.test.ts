import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
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
    publisher: 'orca-samples',
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
    pluginKey: 'orca-samples.portuguese',
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
        id: 'plugin:orca-samples.portuguese/pt-BR',
        resourceLanguage:
          'plugin0070006c007500670069006e003a006f007200630061002d00730061006d0070006c00650073002e0070006f00720074007500670075006500730065002f00700074002d00420052',
        pluginKey: 'orca-samples.portuguese',
        locale: 'pt-BR',
        catalog: { common: { save: 'Salvar' } }
      }
    ])
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })

  it('fails closed for protected security copy and clears state when disabled', async () => {
    const plugin = await pluginWithCatalog({
      auto: { components: { settings: { PluginConsentDialog: { disclaimer: 'Safe' } } } }
    })
    const registry = new PluginLanguagePackRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.error(plugin.pluginKey)).toContain('protected security copy')

    await registry.reconcile([plugin], () => false)
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })
})
