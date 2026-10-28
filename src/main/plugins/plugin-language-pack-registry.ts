import {
  parsePluginLanguagePackArtifact,
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../shared/plugins/plugin-language-pack-artifact'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  PLUGIN_LANGUAGE_PACK_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from './plugin-content-integrity'

type LanguagePackContribution = PluginManifest['contributes']['languagePacks'][number]

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
          ...(contribution.displayName ? { displayName: contribution.displayName } : {}),
          catalog: parsed.catalog
        }
      }
    })
  }
}
