import { common } from '@kit.AbilityKit';
import { getString, KEY_THEME_MODE } from './SettingsStore';

export function applyThemeMode(mode: string): void {
  AppStorage.setOrCreate('themeMode', mode);
  let light = mode === 'light' || (mode === 'system' && AppStorage.get<boolean>('systemLight') === true);
  AppStorage.setOrCreate('themeScheme', light ? 'light' : 'dark');
  AppStorage.setOrCreate('themeBg', light ? '#f5f6f8' : '#111111');
  AppStorage.setOrCreate('themeSurface', light ? '#ffffff' : '#1c1c1c');
  AppStorage.setOrCreate('themeBorder', light ? '#d7dce2' : '#353a42');
  AppStorage.setOrCreate('themeText', light ? '#17212d' : '#e8e8e8');
  AppStorage.setOrCreate('themeMuted', light ? '#59616b' : '#a3a9b2');
  AppStorage.setOrCreate('themeSecondary', light ? '#455463' : '#b5bec9');
  AppStorage.setOrCreate('themeAccent', light ? '#17603f' : '#7ddf7d');
  AppStorage.setOrCreate('themeLink', light ? '#285b94' : '#96b8e5');
  AppStorage.setOrCreate('themeWarning', light ? '#795817' : '#e0c070');
}
export async function loadAppearance(context: common.Context): Promise<void> {
  applyThemeMode(await getString(context, KEY_THEME_MODE));
}
export function setSystemAppearance(colorMode: number): void {
  AppStorage.setOrCreate('systemLight', colorMode === 1);
  applyThemeMode(AppStorage.get<string>('themeMode') ?? 'system');
}
