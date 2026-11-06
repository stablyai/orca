import { app } from 'electron'
import { bindSystemLanguageReader } from '../i18n/system-language'

/** Desktop-only. orcad and the CLI never import this file. */
export function bindElectronSystemLanguage(): void {
  bindSystemLanguageReader({
    isReady: () => app.isReady(),
    preferredLanguages: () => app.getPreferredSystemLanguages()
  })
}
