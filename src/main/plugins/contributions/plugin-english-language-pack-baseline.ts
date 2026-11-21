import english from '../../../renderer/src/i18n/locales/en.json'
import { precomputeEnglishLanguagePackBaseline } from '../../../shared/plugins/languages/plugin-language-pack-coverage'

// Non-bundled callers use the source catalog. Desktop builds replace this module with precomputed data.
export default async function loadPluginEnglishLanguagePackBaseline() {
  return precomputeEnglishLanguagePackBaseline(english)
}
