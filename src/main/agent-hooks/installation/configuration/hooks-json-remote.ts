import type { SFTPWrapper } from 'ssh2'
import type { HooksConfig } from './hook-config-schema'
import { parseHooksJsonText, type HooksJsonSnapshot } from './hooks-json-read'
import { readFile, isNoEntryError } from '../remote/hook-sftp-operations'
import { writeTextFileRemoteAtomic } from '../remote/hook-text-files-remote'

/** Null config means invalid JSON, {} means missing; propagate other I/O failures. */
export async function readHooksJsonRemoteWithRaw(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<HooksJsonSnapshot> {
  let raw: string
  try {
    raw = await readFile(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return { raw: null, config: {} }
    }
    throw err
  }
  return { raw, config: parseHooksJsonText(raw) }
}

/** Null means invalid JSON, {} means missing; propagate other I/O failures. */
export async function readHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<HooksConfig | null> {
  return (await readHooksJsonRemoteWithRaw(sftp, remotePath)).config
}

/**
 * Atomically replace the remote config without rotating local-style backups.
 * With `computedFrom` (the bytes the edit was made from, null for absent), returns false without
 * publishing when the file changed since, so the caller redoes its edit instead of clobbering.
 */
export async function writeHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  config: Record<string, unknown>,
  // JSONC callers can supply text edited in place.
  options?: { serialized?: string; computedFrom?: string | null }
): Promise<boolean> {
  const serialized = options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  return await writeTextFileRemoteAtomic(
    sftp,
    remotePath,
    serialized,
    options && 'computedFrom' in options && options.computedFrom !== undefined
      ? { computedFrom: options.computedFrom }
      : undefined
  )
}
