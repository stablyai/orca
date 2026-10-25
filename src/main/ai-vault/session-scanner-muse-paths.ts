import { basename, dirname } from 'node:path'

export { resolveMuseSessionsDir } from '../../shared/muse-session-log'

// The UUID lives in the parent directory; every transcript basename is session.jsonl.
export function museSessionIdFromFilePath(filePath: string): string {
  return basename(dirname(filePath))
}
