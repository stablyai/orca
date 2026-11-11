// Per-device sync choices and per-workspace indexes under userData. Choices are this member's
// alone (a teammate's toggle never changes them); an index records what this computer copied.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CloudSyncChoice, IndexEntry } from './cloud-sync-plan'

export type { CloudSyncChoice }

/** `.context` is small and holds what people come back for (plans, screenshots): on by default. */
export const DEFAULT_SYNC_CHOICE: CloudSyncChoice = { context: true, mirror: false }

const ChoicesSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(
    z.string(),
    z.object({ context: z.boolean().optional(), mirror: z.boolean().optional() })
  )
})

const IndexEntrySchema = z.object({
  rs: z.number(),
  rm: z.number(),
  ls: z.number(),
  lm: z.number()
})

const IndexSchema = z.object({
  version: z.literal(1),
  folder: z.string(),
  lastSyncedAt: z.number().nullable(),
  entries: z.record(z.string(), IndexEntrySchema)
})

export type CloudSyncIndex = z.infer<typeof IndexSchema>

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
  await rename(temp, path).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
}

export function createCloudSyncStore(userDataPath: string) {
  const dir = join(userDataPath, 'orca-cloud-sync')
  const choicesPath = join(dir, 'choices.json')
  let choices: z.infer<typeof ChoicesSchema> | null = null

  const indexPath = (workspaceId: string): string =>
    join(dir, `${createHash('sha256').update(workspaceId).digest('hex').slice(0, 32)}.json`)

  async function loadChoices(): Promise<z.infer<typeof ChoicesSchema>> {
    if (choices) {
      return choices
    }
    const raw = await readFile(choicesPath, 'utf8').catch(() => null)
    const parsed = raw ? ChoicesSchema.safeParse(safeJson(raw)) : null
    choices = parsed?.success ? parsed.data : { version: 1, workspaces: {} }
    return choices
  }

  return {
    dir,
    async choice(workspaceId: string): Promise<CloudSyncChoice> {
      const saved = (await loadChoices()).workspaces[workspaceId]
      return {
        context: saved?.context ?? DEFAULT_SYNC_CHOICE.context,
        mirror: saved?.mirror ?? DEFAULT_SYNC_CHOICE.mirror
      }
    },
    async setChoice(
      workspaceId: string,
      patch: Partial<CloudSyncChoice>
    ): Promise<CloudSyncChoice> {
      const all = await loadChoices()
      const next = { ...(await this.choice(workspaceId)), ...patch }
      all.workspaces[workspaceId] = next
      await mkdir(dir, { recursive: true })
      await writeJson(choicesPath, all)
      return next
    },
    async forgetChoice(workspaceId: string): Promise<void> {
      const all = await loadChoices()
      if (all.workspaces[workspaceId]) {
        delete all.workspaces[workspaceId]
        await mkdir(dir, { recursive: true })
        await writeJson(choicesPath, all)
      }
    },
    async readIndex(workspaceId: string, folder: string): Promise<CloudSyncIndex> {
      const raw = await readFile(indexPath(workspaceId), 'utf8').catch(() => null)
      const parsed = raw ? IndexSchema.safeParse(safeJson(raw)) : null
      // An index for another folder (workspace renamed) describes files that aren't there.
      if (parsed?.success && parsed.data.folder === folder) {
        return parsed.data
      }
      return { version: 1, folder, lastSyncedAt: null, entries: {} }
    },
    async writeIndex(workspaceId: string, index: CloudSyncIndex): Promise<void> {
      await mkdir(dir, { recursive: true })
      await writeJson(indexPath(workspaceId), index)
    },
    async removeIndex(workspaceId: string): Promise<void> {
      await rm(indexPath(workspaceId), { force: true })
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export type CloudSyncStore = ReturnType<typeof createCloudSyncStore>
export type { IndexEntry }
