import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { redactDiagnosticText } from './ConnectionDiagnostics';

const PREFS_NAME = 'orca_connection_log';
const PREFS_KEY = 'entries';
const MAX_HOST_ENTRIES = 100;
const MAX_TOTAL_ENTRIES = 500;
const MAX_TEXT = 1024;

export const LOG_LEVEL_INFO = 'info';
export const LOG_LEVEL_SUCCESS = 'success';
export const LOG_LEVEL_WARN = 'warn';
export const LOG_LEVEL_ERROR = 'error';

export interface ConnectionLogEntry {
  id: string;
  ts: number;
  level: string;
  message: string;
  detail: string;
  hostId: string;
  code?: string;
  path?: string;
  relayCloseCode?: number;
}

let memoryEntries: ConnectionLogEntry[] = [];
let hydration: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let sequence = 0;
const subscribers: Set<() => void> = new Set();

function parseEntries(text: string): ConnectionLogEntry[] {
  let parsed = JSON.parse(text) as Array<Object>;
  if (!Array.isArray(parsed)) { return []; }
  let entries: ConnectionLogEntry[] = [];
  parsed.slice(-MAX_TOTAL_ENTRIES).forEach((value: Object, index: number): void => {
    if (!value || typeof value !== 'object') { return; }
    let item = value as Record<string, Object>;
    let ts = item['ts']; let level = item['level']; let message = item['message']; let detail = item['detail'];
    if (typeof ts !== 'number' || (!Number.isFinite(ts) || ts < 0 || ts > 8640000000000000) || typeof level !== 'string' || typeof message !== 'string') { return; }
    let entry: ConnectionLogEntry = {
      id: typeof item['id'] === 'string' ? item['id'] as string : `legacy:${index}:${ts}`,
      ts: ts, level: level, message: redactDiagnosticText(message).slice(0, MAX_TEXT),
      detail: typeof detail === 'string' ? redactDiagnosticText(detail).slice(0, MAX_TEXT) : '',
      hostId: typeof item['hostId'] === 'string' ? item['hostId'] as string : '',
      code: typeof item['code'] === 'string' ? item['code'] as string : undefined,
      path: typeof item['path'] === 'string' ? item['path'] as string : undefined,
      relayCloseCode: typeof item['relayCloseCode'] === 'number' ? item['relayCloseCode'] as number : undefined
    };
    entries.push(entry);
  });
  return entries;
}

function loadPrefs(context: common.Context): Promise<preferences.Preferences> {
  return preferences.getPreferences(context, { name: PREFS_NAME });
}

function hydrate(context: common.Context): Promise<void> {
  if (!hydration) {
    hydration = loadPrefs(context).then(async (prefs: preferences.Preferences): Promise<void> => {
      memoryEntries = parseEntries(await prefs.get(PREFS_KEY, '[]') as string);
    }).catch((): void => {});
  }
  return hydration;
}

export function subscribeLogs(listener: () => void): () => void {
  subscribers.add(listener);
  return (): void => { subscribers.delete(listener); };
}

export function appendLog(context: common.Context, level: string, message: string, detail: string,
  hostId: string = '', code?: string, path?: string, relayCloseCode?: number): Promise<void> {
  let ts = Date.now();
  let entry: ConnectionLogEntry = { id: `${ts}:${++sequence}`, ts: ts, level: level,
    message: redactDiagnosticText(message).slice(0, MAX_TEXT), detail: redactDiagnosticText(detail).slice(0, MAX_TEXT),
    hostId: hostId, code: code, path: path, relayCloseCode: relayCloseCode };
  writes = writes.catch(() => {}).then(async (): Promise<void> => {
    await hydrate(context);
    let count = 1;
    memoryEntries = memoryEntries.reverse().filter((held: ConnectionLogEntry): boolean =>
      held.hostId !== hostId || ++count <= MAX_HOST_ENTRIES).reverse();
    memoryEntries.push(entry);
    memoryEntries = memoryEntries.slice(-MAX_TOTAL_ENTRIES);
    subscribers.forEach((listener: () => void): void => listener());
    let prefs = await loadPrefs(context);
    await prefs.put(PREFS_KEY, JSON.stringify(memoryEntries)); await prefs.flush();
  });
  return writes;
}

export async function listLogs(context: common.Context, hostId: string): Promise<ConnectionLogEntry[]> {
  await hydrate(context);
  await writes.catch(() => {});
  return memoryEntries.filter((entry: ConnectionLogEntry): boolean => entry.hostId === hostId);
}
