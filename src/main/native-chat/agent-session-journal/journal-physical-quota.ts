import { lstat, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { AgentSessionJournalError } from './journal-write-guards'

/** Counts every physical file owned by one session, including blobs, durable
 * write temps, and retained quarantine evidence. Symlinks are charged as files
 * but never followed outside the journal directory. */
export async function journalDirectoryBytes(directory: string): Promise<number> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }
  let total = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    total += entry.isDirectory() ? await journalDirectoryBytes(path) : (await lstat(path)).size
  }
  return total
}

export async function assertJournalPhysicalCapacity(input: {
  journalDir: string
  sessionId: string
  maxBytes: number
  peakAdditionalBytes?: number
}): Promise<number> {
  const current = await journalDirectoryBytes(input.journalDir)
  if (current + (input.peakAdditionalBytes ?? 0) > input.maxBytes) {
    throw new AgentSessionJournalError(
      'journal_bound_exceeded',
      `agent-session journal for ${input.sessionId} reached its ${input.maxBytes}-byte physical bound`
    )
  }
  return current
}
