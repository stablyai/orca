import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

/** 最近 100 条连接事件；串行读写保留冷启动历史。 */

const PREFS_NAME = 'orca_connection_log';
const PREFS_KEY = 'entries';
const MAX_ENTRIES = 100;

export const LOG_LEVEL_INFO = 'info';
export const LOG_LEVEL_WARN = 'warn';
export const LOG_LEVEL_ERROR = 'error';

export interface ConnectionLogEntry {
  ts: number; // epoch millis
  level: string; // info | warn | error
  message: string;
  detail: string; // 补充信息，可为空串
}

// 内存镜像，按时间升序（最旧在前）。冷启动后首次 listLogs 时从 preferences 回填。
let memoryEntries: ConnectionLogEntry[] = [];
let loaded = false;
let writes: Promise<void> = Promise.resolve();

function clampToMax(entries: ConnectionLogEntry[]): ConnectionLogEntry[] {
  if (entries.length <= MAX_ENTRIES) {
    return entries;
  }
  return entries.slice(entries.length - MAX_ENTRIES);
}

function parseEntries(text: string): ConnectionLogEntry[] {
  let parsed: Object | null = JSON.parse(text) as Object | null;
  if (parsed === null || !Array.isArray(parsed)) {
    return [];
  }
  let arr = parsed as Array<Object>;
  let entries: ConnectionLogEntry[] = [];
  for (let i = 0; i < arr.length; i++) {
    let item = arr[i] as Record<string, Object>;
    let ts = item['ts'];
    let level = item['level'];
    let message = item['message'];
    let detail = item['detail'];
    if (typeof ts !== 'number' || typeof level !== 'string' || typeof message !== 'string') {
      continue;
    }
    let entry: ConnectionLogEntry = {
      ts: ts,
      level: level,
      message: message,
      detail: typeof detail === 'string' ? detail : ''
    };
    entries.push(entry);
  }
  return entries;
}

async function loadPrefs(context: common.Context): Promise<preferences.Preferences> {
  return preferences.getPreferences(context, { name: PREFS_NAME });
}

/** 追加一条连接事件（同时写内存与 preferences；preferences 失败不影响内存副本）。 */
export function appendLog(context: common.Context, level: string, message: string, detail: string): Promise<void> {
  writes = writes.catch(() => {}).then(async (): Promise<void> => {
    await hydrate(context);
    let entry: ConnectionLogEntry = { ts: Date.now(), level: level, message: message, detail: detail };
    memoryEntries.push(entry); memoryEntries = clampToMax(memoryEntries);
    let prefs = await loadPrefs(context);
    await prefs.put(PREFS_KEY, JSON.stringify(memoryEntries)); await prefs.flush();
  });
  return writes;
}

async function hydrate(context: common.Context): Promise<void> {
  if (loaded) { return; }
  try {
    let prefs = await loadPrefs(context);
    memoryEntries = parseEntries(await prefs.get(PREFS_KEY, '[]') as string);
  } catch (e) { memoryEntries = []; }
  loaded = true;
}

/** 读取全部日志（时间升序）。进程内首次调用会用 preferences 回填内存镜像。 */
export async function listLogs(context: common.Context): Promise<ConnectionLogEntry[]> {
  await writes.catch(() => {});
  await hydrate(context);
  return memoryEntries.slice();
}

/** 清空日志（内存 + preferences）。 */
export function clearLogs(context: common.Context): Promise<void> {
  writes = writes.catch(() => {}).then(async (): Promise<void> => {
    memoryEntries = []; loaded = true;
    let prefs = await loadPrefs(context); await prefs.put(PREFS_KEY, '[]'); await prefs.flush();
  });
  return writes;
}
