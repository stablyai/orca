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
let hydrated = false;
let writes: Promise<void> = Promise.resolve();
let sequence = 0;
let savedSequence = 0;
const subscribers: Set<() => void> = new Set();

function parseEntries(text: string): ConnectionLogEntry[] {
  let parsed: Array<Object>;
  try { parsed = JSON.parse(text) as Array<Object>; } catch (e) { return []; }
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

function boundedEntries(entries: ConnectionLogEntry[]): ConnectionLogEntry[] {
  let retained: ConnectionLogEntry[] = [];
  let counts = new Map<string, number>();
  for (let i = entries.length - 1; i >= 0 && retained.length < MAX_TOTAL_ENTRIES; i--) {
    let entry = entries[i];
    let count = counts.get(entry.hostId) ?? 0;
    if (count >= MAX_HOST_ENTRIES) { continue; }
    retained.push(entry);
    counts.set(entry.hostId, count + 1);
  }
  return retained.reverse();
}

function loadPrefs(context: common.Context): Promise<preferences.Preferences> {
  return preferences.getPreferences(context, { name: PREFS_NAME });
}

function hydrate(context: common.Context): Promise<void> {
  if (hydrated) { return Promise.resolve(); }
  if (!hydration) {
    hydration = loadPrefs(context).then(async (prefs: preferences.Preferences): Promise<void> => {
      let stored = parseEntries(await prefs.get(PREFS_KEY, '[]') as string);
      let merged = stored.concat(memoryEntries).sort((left: ConnectionLogEntry, right: ConnectionLogEntry): number => left.ts - right.ts);
      memoryEntries = boundedEntries(merged);
      hydrated = true;
      if (stored.length > 0) { subscribers.forEach((listener: () => void): void => listener()); }
    }).finally((): void => { hydration = null; });
  }
  return hydration;
}

function persist(context: common.Context): Promise<void> {
  writes = writes.catch(() => {}).then(async (): Promise<void> => {
    if (savedSequence === sequence) { return; }
    // A failed read cannot turn an in-memory buffer into a replacement for the on-disk log.
    await hydrate(context);
    let prefs = await loadPrefs(context);
    let writing = sequence;
    await prefs.put(PREFS_KEY, JSON.stringify(memoryEntries)); await prefs.flush();
    savedSequence = writing;
  });
  return writes;
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
  memoryEntries = boundedEntries(memoryEntries.concat([entry]));
  let saved = persist(context);
  subscribers.forEach((listener: () => void): void => listener());
  return saved;
}

export async function listLogs(context: common.Context, hostId: string): Promise<ConnectionLogEntry[]> {
  try { await hydrate(context); }
  catch (e) { await hydrate(context).catch((): void => {}); }
  if (hydrated && savedSequence !== sequence) { persist(context).catch((): void => {}); }
  return memoryEntries.filter((entry: ConnectionLogEntry): boolean => entry.hostId === hostId);
}
