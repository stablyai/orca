import { basename, dirname } from 'node:path'

export { resolveMuseSessionsDir } from '../../shared/muse-session-log'

// Layout: <root>/YYYY/MM/DD/<uuid>/session.jsonl — the session id is the
// parent directory name (the basename is always the fixed `session.jsonl`).
export function museSessionIdFromFilePath(filePath: string): string {
  return basename(dirname(filePath))
}
