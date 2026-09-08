import { createInstance } from 'i18next'
import en from './terminal-appearance/en.json'
import ko from './terminal-appearance/ko.json'
import zh from './terminal-appearance/zh.json'
import ja from './terminal-appearance/ja.json'
import es from './terminal-appearance/es.json'
import de from './terminal-appearance/de.json'
import fr from './terminal-appearance/fr.json'

export const terminalAppearanceI18n = createInstance()
void terminalAppearanceI18n.init({
  initAsync: false,
  lng: Intl.DateTimeFormat().resolvedOptions().locale,
  fallbackLng: 'en',
  load: 'languageOnly',
  supportedLngs: ['en', 'ko', 'zh', 'ja', 'es', 'de', 'fr'],
  resources: {
    en: { translation: en },
    ko: { translation: ko },
    zh: { translation: zh },
    ja: { translation: ja },
    es: { translation: es },
    de: { translation: de },
    fr: { translation: fr }
  }
})

export function terminalAppearanceText(key: keyof typeof en): string {
  return terminalAppearanceI18n.t(key)
}
