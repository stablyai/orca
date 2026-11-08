import { common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { utf8Decode } from '../transport/crypto/Bytes';
import { getString, setString } from './SettingsStore';

export interface UiLanguageChoice { value: string; label: string; }
export const UI_LANGUAGE_CHOICES: UiLanguageChoice[] = [
  { value: 'system', label: 'System' }, { value: 'en', label: 'English' }, { value: 'zh', label: '简体中文' },
  { value: 'zh-Hant', label: '繁體中文' }, { value: 'ko', label: '한국어' }, { value: 'ja', label: '日本語' },
  { value: 'es', label: 'Español' }, { value: 'fr', label: 'Français' }, { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' }, { value: 'tr', label: 'Türkçe' }, { value: 'de', label: 'Deutsch' }
];
let labels: Record<string, Record<string, string>> = {};
let activation = 0;
let localeListener: (() => void) | null = null;
export function setUiLocaleListener(listener: (() => void) | null): void { localeListener = listener; }

export function uiText(text: string, locale: string): string {
  let row = labels[text]; return row ? row[locale] || row['en'] || text : text;
}

export function resolveUiLocale(preference: string, system: string): string {
  let tag = (preference === 'system' ? system : preference).replace(/_/g, '-');
  let parts = tag.split('-'); let language = parts[0].toLowerCase();
  if (language === 'zh') {
    let normalized = tag.toLowerCase();
    return normalized.includes('hant') || /-(tw|hk|mo)(?:-|$)/.test(normalized) ? 'zh-Hant' : 'zh';
  }
  return UI_LANGUAGE_CHOICES.some((choice: UiLanguageChoice): boolean => choice.value === language && language !== 'system') ? language : 'en';
}

export function applyUiLanguage(): void {
  let preference = AppStorage.get<string>('uiLanguagePreference') ?? 'system';
  AppStorage.setOrCreate('uiLocale', resolveUiLocale(preference, i18n.System.getSystemLanguage()));
  if (localeListener) { localeListener(); }
}

export async function loadUiLanguage(context: common.Context): Promise<void> {
  let current = ++activation;
  let bytes = await context.resourceManager.getRawFileContent('i18n/native-ui.json');
  let catalog = JSON.parse(utf8Decode(bytes)) as Record<string, Record<string, string>>;
  let preference = await getString(context, 'ui.language');
  labels = catalog;
  if (current !== activation) { return; }
  AppStorage.setOrCreate('uiLanguagePreference', UI_LANGUAGE_CHOICES.some((choice: UiLanguageChoice): boolean => choice.value === preference) ? preference : 'system');
  applyUiLanguage();
}

export async function setUiLanguage(context: common.Context, preference: string): Promise<void> {
  if (!UI_LANGUAGE_CHOICES.some((choice: UiLanguageChoice): boolean => choice.value === preference)) { throw new Error('Unsupported language'); }
  activation++;
  await setString(context, 'ui.language', preference);
  AppStorage.setOrCreate('uiLanguagePreference', preference); applyUiLanguage();
}
