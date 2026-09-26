/**
 * The agent-session store's primary file as bytes. A transaction hashes these on every refresh and
 * parses them only when the hash differs from the bytes it last loaded or wrote.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** The primary file's exact bytes, read once so one buffer is both hashed and decoded. */
export type AgentSessionStorePrimaryBytes = { bytes: Buffer; sha256: string }

export function agentSessionStoreBytesSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Null when the primary is absent. */
export async function readAgentSessionStorePrimary(
  filePath: string
): Promise<AgentSessionStorePrimaryBytes | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    // Only a missing or unparseable primary means "fall back". A transient read failure (EACCES,
    // EIO, EMFILE) says nothing about the primary's contents, and treating it as recovery would
    // replace newer state with a stale backup and latch the recovery path.
    throw new Error('agent_session_store_corrupt')
  }
  return { bytes, sha256: agentSessionStoreBytesSha256(bytes) }
}
