import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

/**
 * 应用设置存储：所有设置项集中在同一个 preferences 文件（'orca_settings'），
 * 键名与默认值收敛在下方默认值表；页面统一通过 getBool/getString/getNumber
 * 与 setBool/setString/setNumber 读写，避免裸键名散落各处。
 */

const PREFS_NAME = 'orca_settings';

// ---------- 键名 ----------
export const KEY_THEME_MODE = 'appearance.themeMode';
export const KEY_HOME_FONT_SCALE = 'appearance.homeFontScale';
export const KEY_TERMINAL_FONT_SCALE = 'terminal.fontScale';
export const KEY_TERMINAL_FONT_FAMILY = 'terminal.fontFamily';
export const KEY_TERMINAL_SHOW_KEY_RAIL = 'terminal.showKeyRail';
export const KEY_DICTATION_ENGINE = 'dictation.engine';
export const KEY_NOTIFICATIONS_LOCAL_ENABLED = 'notifications.localEnabled';
export const KEY_NOTIFICATIONS_DND_ENABLED = 'notifications.dndEnabled';

// ---------- 枚举值（字符串常量） ----------
export const THEME_MODE_SYSTEM = 'system';
export const THEME_MODE_LIGHT = 'light';
export const THEME_MODE_DARK = 'dark';

export const FONT_FAMILY_MONO = 'mono';
export const FONT_FAMILY_SANS = 'sans';

export const DICTATION_ENGINE_DESKTOP = 'desktop';
export const DICTATION_ENGINE_ONDEVICE = 'ondevice';

// ---------- 可选项表（页面渲染与摘要共用） ----------
export interface OptionEntry {
  value: string;
  label: string;
  desc: string;
}

export const THEME_MODE_OPTIONS: OptionEntry[] = [
  { value: THEME_MODE_SYSTEM, label: '跟随系统', desc: '随系统深浅色模式自动切换' },
  { value: THEME_MODE_LIGHT, label: '浅色', desc: '固定使用浅色主题' },
  { value: THEME_MODE_DARK, label: '深色', desc: '固定使用深色主题' }
];

export const FONT_FAMILY_OPTIONS: OptionEntry[] = [
  { value: FONT_FAMILY_MONO, label: '等宽字体', desc: '列对齐稳定，适合代码与日志' },
  { value: FONT_FAMILY_SANS, label: '无衬线字体（暂不可用）', desc: '终端当前固定使用等宽字体，以保证列对齐' }
];

export const DICTATION_ENGINE_OPTIONS: OptionEntry[] = [
  { value: DICTATION_ENGINE_DESKTOP, label: '桌面转写（推荐）', desc: '音频送到已配对桌面完成识别，质量稳定' },
  { value: DICTATION_ENGINE_ONDEVICE, label: '端上识别（暂不可用）', desc: '当前版本使用桌面转写，端上识别尚未接入' }
];

/** 按 value 找展示名（找不到时原样返回）。 */
export function optionLabel(options: OptionEntry[], value: string): string {
  for (let i = 0; i < options.length; i++) {
    if (options[i].value === value) {
      return options[i].label;
    }
  }
  return value;
}

// ---------- 默认值表 ----------
interface BoolDefault {
  key: string;
  value: boolean;
}

interface StringDefault {
  key: string;
  value: string;
}

interface NumberDefault {
  key: string;
  value: number;
}

const BOOL_DEFAULTS: BoolDefault[] = [
  { key: KEY_TERMINAL_SHOW_KEY_RAIL, value: true },
  { key: KEY_NOTIFICATIONS_LOCAL_ENABLED, value: true },
  { key: KEY_NOTIFICATIONS_DND_ENABLED, value: false }
];

const STRING_DEFAULTS: StringDefault[] = [
  { key: KEY_THEME_MODE, value: THEME_MODE_SYSTEM },
  { key: KEY_TERMINAL_FONT_FAMILY, value: FONT_FAMILY_MONO },
  { key: KEY_DICTATION_ENGINE, value: DICTATION_ENGINE_DESKTOP }
];

const NUMBER_DEFAULTS: NumberDefault[] = [
  { key: KEY_HOME_FONT_SCALE, value: 1 },
  { key: KEY_TERMINAL_FONT_SCALE, value: 14 }
];

function boolDefaultFor(key: string): boolean {
  for (let i = 0; i < BOOL_DEFAULTS.length; i++) {
    if (BOOL_DEFAULTS[i].key === key) {
      return BOOL_DEFAULTS[i].value;
    }
  }
  return false;
}

function stringDefaultFor(key: string): string {
  for (let i = 0; i < STRING_DEFAULTS.length; i++) {
    if (STRING_DEFAULTS[i].key === key) {
      return STRING_DEFAULTS[i].value;
    }
  }
  return '';
}

function numberDefaultFor(key: string): number {
  for (let i = 0; i < NUMBER_DEFAULTS.length; i++) {
    if (NUMBER_DEFAULTS[i].key === key) {
      return NUMBER_DEFAULTS[i].value;
    }
  }
  return 0;
}

async function loadPrefs(context: common.Context): Promise<preferences.Preferences> {
  return preferences.getPreferences(context, { name: PREFS_NAME });
}

export async function getBool(context: common.Context, key: string): Promise<boolean> {
  let fallback = boolDefaultFor(key);
  try {
    let prefs = await loadPrefs(context);
    let value: preferences.ValueType = await prefs.get(key, fallback);
    return typeof value === 'boolean' ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

export async function getString(context: common.Context, key: string): Promise<string> {
  let fallback = stringDefaultFor(key);
  try {
    let prefs = await loadPrefs(context);
    let value: preferences.ValueType = await prefs.get(key, fallback);
    if (key === KEY_DICTATION_ENGINE) { return DICTATION_ENGINE_DESKTOP; }
    if (key === KEY_TERMINAL_FONT_FAMILY) { return FONT_FAMILY_MONO; }
    return typeof value === 'string' ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

export async function getNumber(context: common.Context, key: string): Promise<number> {
  let fallback = numberDefaultFor(key);
  try {
    let prefs = await loadPrefs(context);
    let value: preferences.ValueType = await prefs.get(key, fallback);
    return typeof value === 'number' ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

export async function setBool(context: common.Context, key: string, value: boolean): Promise<void> {
  let prefs = await loadPrefs(context);
  await prefs.put(key, value);
  await prefs.flush();
}

export async function setString(context: common.Context, key: string, value: string): Promise<void> {
  let prefs = await loadPrefs(context);
  await prefs.put(key, value);
  await prefs.flush();
}

export async function setNumber(context: common.Context, key: string, value: number): Promise<void> {
  let prefs = await loadPrefs(context);
  await prefs.put(key, value);
  await prefs.flush();
}
