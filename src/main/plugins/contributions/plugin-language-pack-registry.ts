import {
  parsePluginLanguagePackArtifact,
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import {
  pluginLanguagePackCoverage,
  translatableCatalogPaths
} from '../../../shared/plugins/languages/plugin-language-pack-coverage'
import {
  englishSourceLookup,
  type EnglishSourceLookup
} from '../../../shared/plugins/languages/plugin-translation-string-policy'
import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_LANGUAGE_PACK_MAX_BYTES,
  readContainedPluginArtifactText
} from '../plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from '../plugin-content-integrity'

type LanguagePackContribution = PluginManifest['contributes']['languagePacks'][number]

type EnglishSource = { translatablePaths: ReadonlySet<string>; lookup: EnglishSourceLookup }

let englishSource: Promise<EnglishSource> | null = null

// Why lazy: the English catalog is ~1 MB and only matters once a language pack loads.
function loadEnglishSource(): Promise<EnglishSource> {
  englishSource ??= import('../../../renderer/src/i18n/locales/en.json').then((module) => ({
    translatablePaths: translatableCatalogPaths(module.default),
    lookup: englishSourceLookup(module.default)
  }))
  return englishSource
}

export class PluginLanguagePackRegistry extends PluginArtifactPackRegistry<
  LanguagePackContribution,
  PluginLanguagePackRegistration
> {
  constructor(contentVerifier: PluginContentVerifier) {
    super({
      contentVerifier,
      contributions: (plugin) => plugin.manifest.contributes.languagePacks,
      load: async (plugin, contribution) => {
        const text = await readContainedPluginArtifactText(
          plugin.rootDir,
          contribution.path,
          PLUGIN_LANGUAGE_PACK_MAX_BYTES
        )
        const english = await loadEnglishSource()
        const parsed = parsePluginLanguagePackArtifact(text, 'tolerant', english.lookup)
        if (!parsed.ok) {
          throw new Error(`language pack "${contribution.locale}" ${parsed.error}`)
        }
        const id = `plugin:${plugin.pluginKey}/${contribution.locale}` as const
        return {
          id,
          resourceLanguage: pluginLanguageResourceId(id),
          pluginKey: plugin.pluginKey,
          locale: contribution.locale,
          ...(contribution.displayName ? { displayName: contribution.displayName } : {}),
          catalog: parsed.catalog,
          coverage: pluginLanguagePackCoverage(parsed.catalog, english.translatablePaths)
        }
      }
    })
  }
}
