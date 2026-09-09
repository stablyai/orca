import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Why: MuseCode stores sessions under <XDG_DATA_HOME>/muse/sessions (default
// ~/.local/share/muse/sessions), sharded by date:
// <root>/YYYY/MM/DD/<uuid>/session.jsonl. No upstream home/session-dir
// override variable was observed, so resolution is XDG data home with the
// platform-default fallback (same shape as OpenCode's store).
export function resolveMusecodeSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return join(dataHome, 'muse', 'sessions')
}

// Layout: <root>/YYYY/MM/DD/<uuid>/session.jsonl — the session id is the
// parent directory name (the basename is always the fixed `session.jsonl`).
export function musecodeSessionIdFromFilePath(filePath: string): string {
  return basename(dirname(filePath))
}
