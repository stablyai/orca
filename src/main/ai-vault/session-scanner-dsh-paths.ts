import { basename, dirname } from 'node:path'

export { resolveDshSessionsDir } from '../../shared/dsh-session-paths'

// `session.v<generation>.jsonl`, zstd-compressed by default (`.jsonl.zstd`).
// A dir holding only `session.lock` is a session that never wrote a header.
const DSH_SESSION_FILE_NAME = /^session\.v(\d+)\.jsonl(\.zstd)?$/

export const DSH_ZSTD_SESSION_FILE_SUFFIX = '.zstd'

export function isDshSessionFilePath(filePath: string): boolean {
  return DSH_SESSION_FILE_NAME.test(basename(filePath))
}

/** The file format generation N from `session.v<N>...`; 0 when the name does not match. */
export function dshSessionFileGeneration(filePath: string): number {
  const match = DSH_SESSION_FILE_NAME.exec(basename(filePath))
  return match ? Number(match[1]) : 0
}

/** The session id is the directory holding the generation file. */
export function dshSessionIdFromFilePath(filePath: string): string {
  return basename(dirname(filePath))
}
