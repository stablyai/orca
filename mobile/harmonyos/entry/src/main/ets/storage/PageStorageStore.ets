import { PAGE_PREFERENCE_KEYS, readPagePreferencesSync, writePagePreferenceSync } from '../settings/SettingsStore';
import { DeviceRowStore, deleteDeviceRows } from './DeviceRowStore';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

/** Host-scoped durable page state. Commit before acknowledging a storage notify. */
export class PageStorageStore {
  private prefs: preferences.Preferences;
  private context: common.Context;
  private hostId: string;
  private rowsStore: DeviceRowStore | null = null;
  constructor(context: common.Context, hostId: string) {
    if (!/^[a-f0-9]{32}$/.test(hostId)) { throw new Error('Invalid host storage identity'); }
    this.context = context; this.hostId = hostId;
    this.prefs = preferences.getPreferencesSync(context, { name: `orca_page_${hostId}` });
  }
  rows(params: ESObject): Promise<Object> {
    if (!this.rowsStore) { this.rowsStore = new DeviceRowStore(this.context, this.hostId); }
    return this.rowsStore.serve(params);
  }
  entries(): Map<string, string> {
    let result: Map<string, string> = new Map();
    let all = JSON.parse(this.prefs.getSync('entries', '{}') as string) as Record<string, preferences.ValueType>;
    let keys = Object.keys(all);
    for (let i = 0; i < keys.length && result.size < 512; i++) {
      let value = all[keys[i]];
      if (typeof value === 'string' && keys[i].length <= 256) { result.set(keys[i], value); }
    }
    let global = readPagePreferencesSync(this.context);
    for (let i = 0; i < PAGE_PREFERENCE_KEYS.length; i++) { result.delete(PAGE_PREFERENCE_KEYS[i]); }
    global.forEach((value: string, key: string): void => { result.set(key, value); });
    return result;
  }
  write(key: string, value: string | null): void {
    if (key.length > 256 || (value !== null && value.length > 16384)) { throw new Error('Page storage limit'); }
    if (PAGE_PREFERENCE_KEYS.includes(key)) { writePagePreferenceSync(this.context, key, value); return; }
    let held = this.entries();
    if (value === null) { held.delete(key); } else { held.set(key, value); }
    if (held.size > 512) { throw new Error('Page storage full'); }
    let record: Record<string, string> = {};
    held.forEach((item: string, name: string): void => { if (!PAGE_PREFERENCE_KEYS.includes(name)) { record[name] = item; } });
    let encoded = JSON.stringify(record);
    if (encoded.length > 8 * 1024 * 1024) { throw new Error('Page storage full'); }
    let previous = this.prefs.getSync('entries', '{}');
    try { this.prefs.putSync('entries', encoded); this.prefs.flushSync(); }
    catch (e) { this.prefs.putSync('entries', previous); throw new Error('Page storage could not be committed'); }
  }
}

export async function deletePageStorage(context: common.Context, hostId: string): Promise<void> {
  if (/^[a-f0-9]{32}$/.test(hostId)) {
    await preferences.deletePreferences(context, { name: `orca_page_${hostId}` });
    await deleteDeviceRows(context, hostId);
  }
}
