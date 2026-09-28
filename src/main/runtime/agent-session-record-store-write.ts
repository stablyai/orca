/**
 * Committing the durable agent-session store.
 *
 * Split from the read/parse half so neither outgrows its budget. The ordering below is the whole
 * reason this is its own file: the live path is never absent. New content is made durable in a temp
 * file first, a validated primary is COPIED to the backup, and only then does the rename publish it.
 * Backup recovery keeps the known-good backup in place while publishing the repaired primary.
 *
 * The old ordering renamed the live file aside before writing the new one, so a death in that
 * window left the profile with a backup and no primary — which is exactly the state that wedged a
 * real profile. Copy, don't move.
 */

import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  copyFileDurable,
  durableWriteTempPath,
  renameDurable,
  writeTempFileDurable
} from '../durable-file-write'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { serializeAgentSessionStoreState } from './agent-session-store-serialization'

export const agentSessionStoreBackupPath = (filePath: string): string => `${filePath}.bak`

/** Returns the exact text it published, so the caller derives revision and byte hash from it. */
export async function saveAgentSessionStore(
  filePath: string,
  state: AgentSessionStoreState,
  options: { primaryStatus: 'validated' | 'unusable-or-absent' }
): Promise<string> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const tmpPath = durableWriteTempPath(filePath)
  const serialized = serializeAgentSessionStoreState(state)
  try {
    await writeTempFileDurable(tmpPath, serialized, 0o600)
    // Only a primary parsed under the transaction lock may replace the backup. During recovery the
    // primary is corrupt or absent, so the known-good backup must survive until publication.
    if (options.primaryStatus === 'validated') {
      await copyFileDurable(filePath, agentSessionStoreBackupPath(filePath))
    }
    await renameDurable(tmpPath, filePath)
    return serialized
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}
