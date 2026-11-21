import {
  parsePluginLanguagePackArtifact,
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import {
  englishBaselinePartition,
  pluginLanguagePackCoverage,
  type TranslatableCatalogPaths
} from '../../../shared/plugins/languages/plugin-language-pack-coverage'
import {
  withEnglishPluralFallback,
  type EnglishSourceLookup
} from '../../../shared/plugins/languages/plugin-translation-string-policy'
import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_LANGUAGE_PACK_MAX_BYTES } from '../artifacts/plugin-artifact-validation'
import { readContainedPluginArtifactText } from '../artifacts/plugin-contained-artifact'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from '../artifacts/plugin-content-integrity'

type LanguagePackContribution = PluginManifest['contributes']['languagePacks'][number]

type EnglishSource = { translatablePaths: TranslatableCatalogPaths; lookup: EnglishSourceLookup }

let englishSource: Promise<EnglishSource> | null = null

// The build precomputes the flat baseline. Read it only when a language pack loads.
function loadEnglishSource(): Promise<EnglishSource> {
  englishSource ??= import('./plugin-english-language-pack-baseline').then(
    async ({ default: loadBaseline }) => {
      const { partitions, translatableCount } = await loadBaseline()
      const readExact = (path: string) => {
        const entries = partitions[englishBaselinePartition(path)]
        return Object.hasOwn(entries, path) ? entries[path] : undefined
      }
      return {
        translatablePaths: { size: translatableCount, has: (path) => (readExact(path) ?? -1) >= 0 },
        lookup: withEnglishPluralFallback((path) => {
          const facts = readExact(path)
          return facts === undefined || facts >= 0 ? facts : -facts - 1
        })
      }
    }
  )
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
