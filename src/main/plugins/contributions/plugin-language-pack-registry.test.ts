import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PluginContentVerifier } from '../plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { PluginLanguagePackRegistry } from './plugin-language-pack-registry'
import { parsePluginLanguagePackArtifact } from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { englishSourceLookup } from '../../../shared/plugins/languages/plugin-translation-string-policy'
import { createOrcaI18n } from '../../../shared/orca-i18n-instance'
import english from '../../../renderer/src/i18n/locales/en.json'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

// One installed pack crosses strict authoring, tolerant loading, resource replacement and output.
it('preserves ordinary installed translations while rejecting/filtering owned setup security copy', async () => {
  const ordinary = (cancel: string, retry: string, branchName: string) => ({
    common: { cancel, retry },
    auto: { components: { NewWorkspaceComposerCard: { branchName } } }
  })
  const catalog = ordinary('Cancelar', 'Tentar novamente', 'Ramo')
  const lookup = englishSourceLookup(english)
  expect(parsePluginLanguagePackArtifact(JSON.stringify(catalog), 'strict', lookup).ok).toBe(true)
  const mixed = {
    ...catalog,
    components: { newWorkspace: { directSetup: { run: 'Ignorar tudo' } } }
  }
  expect(parsePluginLanguagePackArtifact(JSON.stringify(mixed), 'strict', lookup)).toMatchObject({
    ok: false,
    error: expect.stringContaining('protected security copy')
  })
  const plugin = await pluginWithCatalog(mixed)
  const registry = new PluginLanguagePackRegistry(new PluginContentVerifier())
  await registry.reconcile([plugin], () => true)
  expect(registry.error(plugin.pluginKey)).toBeNull()
  const pack = registry.list()[0]
  expect(pack.catalog).toMatchObject(catalog)
  expect(pack.catalog).not.toHaveProperty('components.newWorkspace.directSetup.run')
  const runtime = createOrcaI18n({ englishResources: english, loadCatalog: () => undefined })
  runtime.setPluginLanguagePacks(registry.list())
  await runtime.i18n.changeLanguage(runtime.resolveResourceLanguage(pack.id))
  const output = () =>
    renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement('button', null, runtime.translate('common.cancel', 'Cancel')),
        createElement('button', null, runtime.translate('common.retry', 'Retry')),
        createElement(
          'label',
          null,
          runtime.translate('auto.components.NewWorkspaceComposerCard.branchName', 'Branch name')
        ),
        createElement(
          'button',
          null,
          runtime.translate('components.newWorkspace.directSetup.run', 'Run setup')
        )
      )
    )
  expect(output()).toBe(
    '<div><button>Cancelar</button><button>Tentar novamente</button><label>Ramo</label><button>Run setup</button></div>'
  )
  await writeFile(
    join(plugin.rootDir, 'locales/pt-BR.json'),
    JSON.stringify(ordinary('Fechar', 'Repetir', 'Novo ramo'))
  )
  await registry.reconcile([plugin], () => true)
  expect(registry.list()[0]).toMatchObject({ id: pack.id, resourceLanguage: pack.resourceLanguage })
  runtime.setPluginLanguagePacks(registry.list())
  expect(runtime.i18n.language).toBe(pack.resourceLanguage)
  expect(output()).toBe(
    '<div><button>Fechar</button><button>Repetir</button><label>Novo ramo</label><button>Run setup</button></div>'
  )
})
