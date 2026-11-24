// A deleted bot's footprint at Composio: its sign-ins and triggers. Kept in a list on disk, with the
// project its sign-ins were made in, until that project's key confirms it's gone; so a bot deleted
// while the key was unusable, or before switching projects, is cleaned up later. A project is named
// by its key's fingerprint, so a regenerated key looks like another project: every key removes what
// it can see of a listed bot, and only its own project's key, or one shown to reach it, drops it.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { composioUserOfBot } from '../../shared/composio/composio-apps'
import type { ComposioApi } from './composio-api'
import { composioKeyEnvelopeFile } from './composio-key-store'

/** The bot, and its project named by its key's fingerprint; null when no key was known. */
const Entry = z.object({ botId: z.string().min(1), project: z.string().nullable() })
type Entry = z.infer<typeof Entry>
const PendingFile = z.object({ bots: z.array(Entry) })

/** Next to the key, on the host that runs the bots. */
export const composioCleanupFile = (): string =>
  join(dirname(composioKeyEnvelopeFile().path), 'composio-pending-cleanup.json')

/** Names a key's project without keeping the key; a project key can read no project id. */
export const composioProjectOf = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 16)

/** Signs the user out of every app and deletes every trigger it had. */
export async function removeComposioUser(api: ComposioApi, userId: string): Promise<void> {
  for (const trigger of await api.triggers(userId)) {
    await api.deleteTrigger(trigger.id)
  }
  for (const connection of await api.connections(userId)) {
    await api.disconnect(connection.id)
  }
}

export class ComposioCleanup {
  constructor(private readonly file: string) {}

  pending(): Entry[] {
    if (!existsSync(this.file)) {
      return []
    }
    try {
      return PendingFile.parse(JSON.parse(readFileSync(this.file, 'utf8'))).bots
    } catch {
      return []
    }
  }

  add(entry: Entry): void {
    const bots = this.pending()
    if (!bots.some((listed) => listed.botId === entry.botId)) {
      this.write([...bots, entry])
    }
  }

  /** Cleans up every listed bot that's gone, as far as this key sees; its own project's are done. */
  async drain(api: ComposioApi, key: string, live: (botId: string) => boolean): Promise<void> {
    const project = composioProjectOf(key)
    const done = new Set<string>()
    for (const entry of this.pending()) {
      if (live(entry.botId)) {
        continue
      }
      try {
        await removeComposioUser(api, composioUserOfBot(entry.botId))
        if (entry.project === null || entry.project === project) {
          done.add(entry.botId)
        }
      } catch (error) {
        console.warn('[composio] cleaning up a deleted bot failed; trying again later', error)
      }
    }
    // Re-read, so a bot listed during the pass stays for the next one.
    this.write(this.pending().filter((entry) => !done.has(entry.botId)))
  }

  /** `from`'s key was shown to reach `to`'s project (a regenerated key): its entries are `to`'s. */
  relabel(from: string, to: string): void {
    const bots = this.pending()
    if (from !== to && bots.some((entry) => entry.project === from)) {
      this.write(bots.map((entry) => (entry.project === from ? { ...entry, project: to } : entry)))
    }
  }

  private write(bots: Entry[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify({ bots })}\n`, { mode: 0o600 })
  }
}
