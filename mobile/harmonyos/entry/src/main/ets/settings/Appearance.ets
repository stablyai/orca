import { common } from '@kit.AbilityKit';
import { getString, KEY_THEME_MODE } from './SettingsStore';

let appearanceListener: (() => void) | null = null;
export function setAppearanceListener(listener: (() => void) | null): void { appearanceListener = listener; }

export function applyThemeMode(mode: string): void {
  AppStorage.setOrCreate('themeMode', mode);
  let light = mode === 'light' || (mode === 'system' && AppStorage.get<boolean>('systemLight') === true);
  AppStorage.setOrCreate('themeScheme', light ? 'light' : 'dark');
  AppStorage.setOrCreate('themeBg', light ? '#ffffff' : '#0a0a0a');
  AppStorage.setOrCreate('themeSurface', light ? '#fafafa' : '#171717');
  AppStorage.setOrCreate('themeRaised', light ? '#f5f5f5' : '#262626');
  AppStorage.setOrCreate('themeSheet', light ? '#f5f5f5' : '#171717');
  AppStorage.setOrCreate('themeBorder', light ? '#e5e5e5' : 'rgba(255, 255, 255, 0.07)');
  AppStorage.setOrCreate('themeText', light ? '#0a0a0a' : '#fafafa');
  AppStorage.setOrCreate('themeMuted', light ? '#696969' : '#898989');
  AppStorage.setOrCreate('themeSecondary', light ? '#696969' : '#acacac');
  AppStorage.setOrCreate('themeAccent', light ? '#225be3' : '#3276f2');
  AppStorage.setOrCreate('themeLink', light ? '#225be3' : '#3276f2');
  AppStorage.setOrCreate('themeWarning', light ? '#ca8a04' : '#eab308');
  AppStorage.setOrCreate('themeStatusRed', light ? '#e40014' : '#ff6568');
  if (appearanceListener) { appearanceListener(); }
}
export async function loadAppearance(context: common.Context): Promise<void> {
  applyThemeMode(await getString(context, KEY_THEME_MODE));
}
export function setSystemAppearance(colorMode: number): void {
  AppStorage.setOrCreate('systemLight', colorMode === 1);
  applyThemeMode(AppStorage.get<string>('themeMode') ?? 'system');
}
