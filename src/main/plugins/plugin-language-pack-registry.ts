import {
  parsePluginLanguagePackArtifact,
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../shared/plugins/plugin-language-pack-artifact'
import {
  pluginLanguagePackCoverage,
  translatableCatalogPaths
} from '../../shared/plugins/plugin-language-pack-coverage'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  PLUGIN_LANGUAGE_PACK_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from './plugin-content-integrity'

type LanguagePackContribution = PluginManifest['contributes']['languagePacks'][number]

let englishPaths: Promise<ReadonlySet<string>> | null = null

// Why lazy: the English catalog is ~1 MB and only matters once a language pack loads.
function translatableEnglishPaths(): Promise<ReadonlySet<string>> {
  englishPaths ??= import('../../renderer/src/i18n/locales/en.json').then((module) =>
    translatableCatalogPaths(module.default)
  )
  return englishPaths
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
        const parsed = parsePluginLanguagePackArtifact(text)
        if (!parsed.ok) {
          throw new Error(`language pack "${contribution.locale}" ${parsed.error}`)
        }
        const id = `plugin:${plugin.pluginKey}/${contribution.locale}` as const
        return {
          id,
          resourceLanguage: pluginLanguageResourceId(id),
          pluginKey: plugin.pluginKey,
          locale: contribution.locale,
          catalog: parsed.catalog,
          coverage: pluginLanguagePackCoverage(parsed.catalog, await translatableEnglishPaths())
        }
      }
    })
  }
}
