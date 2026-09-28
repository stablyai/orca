/**
 * The agent-session store's files as bytes, and the key they form. A transaction hashes them on
 * every refresh and parses them only when they differ from the bytes it last loaded or wrote.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** One file's exact bytes, read once so one buffer is both hashed and decoded. */
export type AgentSessionStoreFileBytes = { bytes: Buffer; sha256: string }

/**
 * Every byte a load read, so equal keys load equal states. `backup` is 'unread' when the load never
 * looked at the backup, 'absent' when it was missing, and otherwise the backup's sha256.
 */
export type AgentSessionStoreInputKey = { primarySha256: string; backup: string }

export function agentSessionStoreBytesSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Null when the primary is absent. */
export async function readAgentSessionStorePrimary(
  filePath: string
): Promise<AgentSessionStoreFileBytes | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    // Only a missing or unparseable primary means "fall back". A transient read failure (EACCES,
    // EIO, EMFILE) says nothing about the primary's contents, and treating it as recovery would
    // replace newer state with a stale backup and latch the recovery path.
    throw new Error('agent_session_store_corrupt')
  }
  return { bytes, sha256: agentSessionStoreBytesSha256(bytes) }
}

/** Null when the backup is absent; 'failed' when it exists but could not be read. */
export async function readAgentSessionStoreBackup(
  backupPath: string
): Promise<AgentSessionStoreFileBytes | null | 'failed'> {
  try {
    const bytes = await readFile(backupPath)
    return { bytes, sha256: agentSessionStoreBytesSha256(bytes) }
  } catch (error) {
    return isMissingFileError(error) ? null : 'failed'
  }
}

/** Whether both files still hold the bytes `key` was taken from. */
export async function agentSessionStoreInputsUnchanged(
  key: AgentSessionStoreInputKey | null,
  primary: AgentSessionStoreFileBytes | null,
  backupPath: string
): Promise<boolean> {
  if (!key || !primary || primary.sha256 !== key.primarySha256) {
    return false
  }
  if (key.backup === 'unread') {
    return true
  }
  const backup = await readAgentSessionStoreBackup(backupPath)
  return backup !== 'failed' && (backup?.sha256 ?? 'absent') === key.backup
}
