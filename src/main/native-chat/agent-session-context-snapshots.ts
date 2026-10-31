import { createHash, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import {
  ensureOwnedTempStagingRoot,
  getOwnedTempStagingRoot
} from '../window/owned-temp-staging-root'

const claims = new Map<string, object>()
const publications = new Map<string, Promise<void>>()

export function agentSessionContextSnapshotRoot(stateDirectory: string): string {
  const profile = createHash('sha256').update(resolve(stateDirectory)).digest('hex').slice(0, 16)
  return getOwnedTempStagingRoot(tmpdir(), `orca-handoff-${profile}`)
}

/** One snapshot per chat, replaced on each hand-off; the OS owns temp retention. */
export async function writeAgentSessionContextSnapshot(
  stateDirectory: string,
  sessionId: string,
  text: string
): Promise<string> {
  const root = agentSessionContextSnapshotRoot(stateDirectory)
  const name = createHash('sha256').update(sessionId).digest('hex')
  const path = join(root, `${name}.txt`)
  const temporary = `${path}.${randomUUID()}.part`
  const claim = {}
  claims.set(path, claim)
  const isCurrent = () => claims.get(path) === claim
  let published = false
  try {
    try {
      if (!(await ensureOwnedTempStagingRoot(root))) {
        throw new Error('Chat context snapshot folder is not private')
      }
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
      // Staging can finish out of order; only publication holds the shared path queue.
      published = await runKeyedSerializedOperation(publications, path, () =>
        renameFileWithWindowsRetryAsync(temporary, path, isCurrent)
      )
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    // Cleanup can yield to a newer capture after this attempt's rename completed.
    if (!published || !isCurrent()) {
      throw new Error('Chat context snapshot publication was replaced')
    }
    return path
  } finally {
    if (isCurrent()) {
      claims.delete(path)
    }
  }
}
