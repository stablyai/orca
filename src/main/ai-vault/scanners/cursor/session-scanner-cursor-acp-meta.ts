import { dirname, join, posix, win32 } from 'node:path'
import { extractString } from '../../../../shared/text/trimmed-string'
import { readJsonObjectIfExists } from '../../discovery/session-json-file'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'

export function cursorAcpSessionMetaPath(storePath: string): string {
  return join(dirname(storePath), 'meta.json')
}

export async function readCursorAcpSessionMeta(
  storePath: string,
  signal?: AbortSignal
): Promise<{ cwd: string; title: string | null } | null> {
  const record = await readJsonObjectIfExists(cursorAcpSessionMetaPath(storePath), signal)
  const cwd = extractString(record?.cwd)
  // Cursor skips a session whose meta.json has no cwd; it records an absolute one.
  if (!cwd || !(posix.isAbsolute(cwd) || win32.isAbsolute(cwd))) {
    return null
  }
  return { cwd, title: normalizeTitleText(extractString(record?.title) ?? '') }
}
