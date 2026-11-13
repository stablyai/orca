import { common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { utf8Decode } from '../transport/crypto/Bytes';
import { getString, setString } from './SettingsStore';

export interface UiLanguageChoice { value: string; label: string; }
export const UI_LANGUAGE_CHOICES: UiLanguageChoice[] = [
  { value: 'system', label: 'System' }, { value: 'en', label: 'English' }, { value: 'zh', label: '中文（简体）' },
  { value: 'zh-Hant', label: '繁體中文（台灣）' }, { value: 'ko', label: '한국어' }, { value: 'ja', label: '日本語' },
  { value: 'es', label: 'Español' }, { value: 'fr', label: 'Français' }, { value: 'pt', label: 'Português (Brasil)' },
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
  const tag = (preference === 'system' ? system : preference).trim().replace(/_/g, '-').toLowerCase();
  const parts = tag.split('-');
  const language = parts[0];
  if (language === 'zh') {
    const script = parts[1] ?? '';
    if (/^[a-z]{4}$/.test(script)) {
      return script === 'hans' ? 'zh' : script === 'hant' ? 'zh-Hant' : 'en';
    }
    return ['tw', 'hk', 'mo'].includes(parts[1] ?? '') ? 'zh-Hant' : 'zh';
  }
  return UI_LANGUAGE_CHOICES.some((choice: UiLanguageChoice): boolean => choice.value === language && language !== 'system') ? language : 'en';
}

export function applyUiLanguage(): void {
  const preference = AppStorage.get<string>('uiLanguagePreference') ?? 'system';
  const system = i18n.System.getSystemLanguage();
  const systemLocale = resolveUiLocale('system', system);
  AppStorage.setOrCreate('systemUiLocale', systemLocale);
  AppStorage.setOrCreate('uiLocale', preference === 'system' ? systemLocale : resolveUiLocale(preference, system));
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
