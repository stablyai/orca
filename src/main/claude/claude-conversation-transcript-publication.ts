import { open, rm } from 'node:fs/promises'
import { renameDurable } from '../filesystem/durable-file-write'

/** Serialize one record at a time, then publish the fsynced file with Windows rename retries. */
export async function publishClaudeConversationTranscript(
  temporaryPath: string,
  destination: string,
  entries: Iterable<unknown>
): Promise<void> {
  const handle = await open(temporaryPath, 'wx', 0o600)
  let published = false
  try {
    try {
      for (const entry of entries) {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameDurable(temporaryPath, destination)
    published = true
  } finally {
    if (!published) {
      await rm(temporaryPath, { force: true })
    }
  }
}
