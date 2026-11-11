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
export const KEY_TERMINAL_FONT_SCALE = 'terminal.fontScale';
export const KEY_TERMINAL_TEXT_SCALE = 'orca:terminalTextScale';
export const KEY_DEFAULT_SESSION_VIEW = 'orca:defaultSessionView';
export const KEY_TERMINAL_LINK_MODE = 'orca:terminalLinkOpenMode';
export const TERMINAL_TEXT_SCALES: number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const KEY_TERMINAL_FONT_FAMILY = 'terminal.fontFamily';
export const KEY_TERMINAL_SHOW_KEY_RAIL = 'terminal.showKeyRail';
export const KEY_DICTATION_ENGINE = 'orca:dictationEngine';
export const KEY_NOTIFICATIONS_LOCAL_ENABLED = 'notifications.localEnabled';
export const KEY_NOTIFICATIONS_DND_ENABLED = 'notifications.dndEnabled';
export const KEY_NOTIFICATIONS_PERMISSION_DECIDED = 'notifications.permissionDecided';

// ---------- 枚举值（字符串常量） ----------
export const THEME_MODE_SYSTEM = 'system';
export const THEME_MODE_LIGHT = 'light';
export const THEME_MODE_DARK = 'dark';

export const FONT_FAMILY_MONO = 'mono';
export const FONT_FAMILY_SANS = 'sans';

export const DICTATION_ENGINE_AUTOMATIC = 'automatic';
export const DICTATION_ENGINE_DESKTOP = 'computer';
export const DICTATION_ENGINE_ONDEVICE = 'phone';

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
  { value: DICTATION_ENGINE_AUTOMATIC, label: '自动', desc: '' },
  { value: DICTATION_ENGINE_ONDEVICE, label: '此手机', desc: '' },
  { value: DICTATION_ENGINE_DESKTOP, label: '电脑', desc: '' }
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
  { key: KEY_DEFAULT_SESSION_VIEW, value: 'terminal' },
  { key: KEY_TERMINAL_LINK_MODE, value: 'orca-browser' },
  { key: KEY_TERMINAL_FONT_FAMILY, value: FONT_FAMILY_MONO },
  { key: KEY_DICTATION_ENGINE, value: DICTATION_ENGINE_AUTOMATIC }
];

const NUMBER_DEFAULTS: NumberDefault[] = [
  { key: KEY_TERMINAL_TEXT_SCALE, value: 1 },
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
    if (key === KEY_DICTATION_ENGINE) { return await readDictationEngine(context); }
    let prefs = await loadPrefs(context);
    let value: preferences.ValueType = await prefs.get(key, fallback);
    if (key === KEY_THEME_MODE && ![THEME_MODE_SYSTEM, THEME_MODE_LIGHT, THEME_MODE_DARK].includes(value as string)) { return THEME_MODE_SYSTEM; }
    if (PAGE_PREFERENCE_KEYS.includes(key) && typeof value === 'string') {
      try { validatePagePreference(key, value); } catch (e) { return fallback; }
    }
    if (key === KEY_TERMINAL_FONT_FAMILY) { return FONT_FAMILY_MONO; }
    return typeof value === 'string' ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

export async function readDictationEngine(context: common.Context): Promise<string> {
  let prefs = await loadPrefs(context);
  let value = await prefs.get(KEY_DICTATION_ENGINE, '');
  if (value === '') { value = await prefs.get('dictation.engine', DICTATION_ENGINE_AUTOMATIC); }
  if (value === 'desktop' || value === DICTATION_ENGINE_DESKTOP) { return DICTATION_ENGINE_DESKTOP; }
  if (value === 'ondevice' || value === DICTATION_ENGINE_ONDEVICE) { return DICTATION_ENGINE_ONDEVICE; }
  return DICTATION_ENGINE_AUTOMATIC;
}

export async function getNumber(context: common.Context, key: string): Promise<number> {
  let fallback = numberDefaultFor(key);
  try {
    let prefs = await loadPrefs(context);
    let value: preferences.ValueType = await prefs.get(key, fallback);
    if (key === KEY_TERMINAL_TEXT_SCALE) { return typeof value === 'string' && TERMINAL_TEXT_SCALES.includes(Number(value)) ? Number(value) : fallback; }
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

function persistSync(context: common.Context, key: string, value: preferences.ValueType | null): void {
  let prefs = preferences.getPreferencesSync(context, { name: PREFS_NAME });
  let existed = prefs.hasSync(key);
  let previous = prefs.getSync(key, '');
  try {
    if (value === null) { prefs.deleteSync(key); } else { prefs.putSync(key, value); }
    prefs.flushSync();
  } catch (e) {
    if (existed) { prefs.putSync(key, previous); } else { prefs.deleteSync(key); }
    throw new Error((e as Error).message);
  }
}

async function persist(context: common.Context, key: string, value: preferences.ValueType | null): Promise<void> {
  persistSync(context, key, value);
}

export async function setBool(context: common.Context, key: string, value: boolean): Promise<void> {
  await persist(context, key, value);
}

export async function setString(context: common.Context, key: string, value: string): Promise<void> {
  if (key === KEY_THEME_MODE && ![THEME_MODE_SYSTEM, THEME_MODE_LIGHT, THEME_MODE_DARK].includes(value)) { throw new Error('Invalid theme'); }
  if (key === KEY_DICTATION_ENGINE && ![DICTATION_ENGINE_AUTOMATIC, DICTATION_ENGINE_ONDEVICE, DICTATION_ENGINE_DESKTOP].includes(value)) { throw new Error('Invalid dictation engine'); }
  if (PAGE_PREFERENCE_KEYS.includes(key)) { validatePagePreference(key, value); }
  await persist(context, key, value);
}

export async function setNumber(context: common.Context, key: string, value: number): Promise<void> {
  if (!Number.isFinite(value)) { throw new Error('Invalid preference number'); }
  if (key === KEY_TERMINAL_TEXT_SCALE) {
    await writePagePreference(context, key, String(value));
  } else { await persist(context, key, value); }
}

export const PAGE_PREFERENCE_KEYS: string[] = [
  'orca:terminal-accessory-layout', 'orca:custom-accessory-keys', KEY_TERMINAL_TEXT_SCALE,
  'orca:terminalAutocompleteEnabled', KEY_TERMINAL_LINK_MODE, 'orca:terminalSplitLayout', KEY_DEFAULT_SESSION_VIEW
];

function validatePagePreference(key: string, value: string): void {
  if (value.length > 16384) { throw new Error('Preference too large'); }
  if (key === KEY_TERMINAL_TEXT_SCALE && !TERMINAL_TEXT_SCALES.includes(Number(value))) { throw new Error('Invalid terminal scale'); }
  if (key === KEY_TERMINAL_LINK_MODE && !['orca-browser', 'phone-browser'].includes(value)) { throw new Error('Invalid link mode'); }
  if (key === KEY_DEFAULT_SESSION_VIEW && !['terminal', 'chat'].includes(value)) { throw new Error('Invalid session view'); }
  if (key === 'orca:terminalSplitLayout' && !['auto', 'side-by-side', 'stacked'].includes(value)) { throw new Error('Invalid split layout'); }
  if (key === 'orca:terminalAutocompleteEnabled' && !['true', 'false'].includes(value)) { throw new Error('Invalid autocomplete'); }
  if (key === 'orca:terminal-accessory-layout' || key === 'orca:custom-accessory-keys') {
    let parsed: ESObject = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object') { throw new Error('Invalid shortcut layout'); }
  }
}

export function readPagePreferencesSync(context: common.Context): Map<string, string> {
  let prefs = preferences.getPreferencesSync(context, { name: PREFS_NAME });
  let result = new Map<string, string>();
  for (let i = 0; i < PAGE_PREFERENCE_KEYS.length; i++) {
    let key = PAGE_PREFERENCE_KEYS[i];
    let value = prefs.getSync(key, '');
    if (typeof value === 'string' && value.length > 0) {
      try { validatePagePreference(key, value); result.set(key, value); } catch (e) { }
    }
  }
  return result;
}

export async function readPagePreferences(context: common.Context): Promise<Map<string, string>> {
  return readPagePreferencesSync(context);
}

export function writePagePreferenceSync(context: common.Context, key: string, value: string | null): void {
  if (!PAGE_PREFERENCE_KEYS.includes(key)) { throw new Error('Not a page preference'); }
  if (value !== null) { validatePagePreference(key, value); }
  persistSync(context, key, value);
}

export async function writePagePreference(context: common.Context, key: string, value: string | null): Promise<void> {
  writePagePreferenceSync(context, key, value);
}

export interface NotificationDeliveryPreferences {
  onlyWhenDesktopAway: boolean;
  onlyWhenAgentNeedsInput: boolean;
  sound: boolean;
  suppressWhileViewing: boolean;
}
const NOTIFICATION_DELIVERY_KEY = 'orca:notificationDeliveryPreferences';
export function notificationDeliveryEnabled(context: common.Context): boolean {
  try {
    let prefs = preferences.getPreferencesSync(context, { name: PREFS_NAME });
    let enabled = prefs.getSync(KEY_NOTIFICATIONS_LOCAL_ENABLED, boolDefaultFor(KEY_NOTIFICATIONS_LOCAL_ENABLED));
    let dnd = prefs.getSync(KEY_NOTIFICATIONS_DND_ENABLED, boolDefaultFor(KEY_NOTIFICATIONS_DND_ENABLED));
    return (typeof enabled === 'boolean' ? enabled : boolDefaultFor(KEY_NOTIFICATIONS_LOCAL_ENABLED))
      && !(typeof dnd === 'boolean' ? dnd : boolDefaultFor(KEY_NOTIFICATIONS_DND_ENABLED));
  } catch (e) { return false; }
}
export function notificationDeliveryPreferences(context: common.Context): NotificationDeliveryPreferences {
  let prefs = preferences.getPreferencesSync(context, { name: PREFS_NAME });
  let raw = prefs.getSync(NOTIFICATION_DELIVERY_KEY, '');
  let stored: ESObject = null;
  if (typeof raw === 'string' && raw.length > 0) { try { stored = JSON.parse(raw); } catch (e) { } }
  return {
    onlyWhenDesktopAway: typeof stored?.onlyWhenDesktopAway === 'boolean' ? stored.onlyWhenDesktopAway : true,
    onlyWhenAgentNeedsInput: typeof stored?.onlyWhenAgentNeedsInput === 'boolean' ? stored.onlyWhenAgentNeedsInput : false,
    sound: typeof stored?.sound === 'boolean' ? stored.sound : true,
    suppressWhileViewing: typeof stored?.suppressWhileViewing === 'boolean' ? stored.suppressWhileViewing : true
  };
}
export async function saveNotificationDeliveryPreferences(context: common.Context, value: NotificationDeliveryPreferences): Promise<void> {
  await persist(context, NOTIFICATION_DELIVERY_KEY, JSON.stringify(value));
}
