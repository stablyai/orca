import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import { parsePersistedSidecar } from '../ai-vault/parse-cache/session-sidecar-stat'

export const SESSION_SEARCH_FILE_COLUMNS = [
  'mtime',
  'size',
  'dev',
  'ino',
  'nlink',
  'alias_mtime',
  'sidecar'
] as const

export function sessionSearchFileValues(file: Omit<FileWithMtime, 'modifiedAt'>) {
  return [
    file.mtimeMs,
    file.sizeBytes ?? null,
    file.dev ?? null,
    file.ino ?? null,
    file.nlink ?? null,
    file.aliasMtimeMs ?? null,
    file.sidecar === undefined ? null : JSON.stringify(file.sidecar)
  ]
}

export function sessionSearchFileFacts(
  row: Record<string, unknown>,
  path: string,
  prefix = ''
): Omit<FileWithMtime, 'modifiedAt'> {
  const number = (name: string) =>
    row[`${prefix}${name}`] == null ? undefined : Number(row[`${prefix}${name}`])
  const sidecar = row[`${prefix}sidecar`]
  return {
    path,
    mtimeMs: Number(row[`${prefix}mtime`]),
    ...(number('size') === undefined ? {} : { sizeBytes: number('size') }),
    ...(number('dev') === undefined ? {} : { dev: number('dev') }),
    ...(number('ino') === undefined ? {} : { ino: number('ino') }),
    ...(number('nlink') === undefined ? {} : { nlink: number('nlink') }),
    ...(number('alias_mtime') === undefined ? {} : { aliasMtimeMs: number('alias_mtime') }),
    ...(sidecar == null ? {} : { sidecar: parsePersistedSidecar(JSON.parse(String(sidecar))) })
  }
}
