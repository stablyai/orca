// orca-fork: each bot's team settings on its host, beside the profile and outside every bot's home, so
// no bot can grant itself the permission.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import {
  AgentTeamSettingsSchema,
  createdInLastDay,
  TEAM_DAILY_CAP_DEFAULT,
  type AgentTeamSettings,
  type AgentTeamView
} from '../../../shared/orca-fork/agent-teams'

const TeamEntrySchema = AgentTeamSettingsSchema.extend({
  created: z.array(z.number()).default([]),
  groupId: z.string().min(1).optional()
})
type TeamEntry = z.infer<typeof TeamEntrySchema>

const TeamFileSchema = z.object({
  version: z.literal(1),
  bots: z.record(z.string(), TeamEntrySchema)
})

export function agentTeamFile(userDataPath: string): string {
  return join(userDataPath, 'orca-fork-agent-teams.json')
}

const OFF: TeamEntry = { teamBuilder: false, dailyCap: TEAM_DAILY_CAP_DEFAULT, created: [] }

export class AgentTeamStore {
  private bots: Promise<Record<string, TeamEntry>> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: () => string) {}

  private load(): Promise<Record<string, TeamEntry>> {
    this.bots ??= readFile(this.path(), 'utf8').then(
      (text) => {
        const parsed = TeamFileSchema.safeParse(JSON.parse(text))
        return parsed.success ? parsed.data.bots : {}
      },
      () => ({})
    )
    return this.bots
  }

  /** Changes one bot's entry; writes run one at a time, each from the entry as it stands then. */
  private change(botId: string, next: (entry: TeamEntry) => TeamEntry): Promise<void> {
    const run = this.writing.then(async () => {
      const bots = await this.load()
      const updated = { ...bots, [botId]: next(bots[botId] ?? OFF) }
      const path = this.path()
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify({ version: 1, bots: updated }, null, 2)}\n`, {
        mode: 0o600
      })
      await rename(temp, path)
      this.bots = Promise.resolve(updated)
    })
    this.writing = run.catch(() => undefined)
    return run
  }

  async entry(botId: string): Promise<TeamEntry> {
    await this.writing
    return (await this.load())[botId] ?? OFF
  }

  async view(botId: string, now = Date.now()): Promise<AgentTeamView> {
    const { teamBuilder, dailyCap, created, groupId } = await this.entry(botId)
    return {
      teamBuilder,
      dailyCap,
      createdToday: createdInLastDay(created, now).length,
      groupId: groupId ?? null
    }
  }

  set(botId: string, settings: Partial<AgentTeamSettings>): Promise<void> {
    return this.change(botId, (entry) => ({ ...entry, ...settings }))
  }

  /** Whether it may create one more bot now: team builder and under its daily cap. */
  async mayCreate(botId: string, now = Date.now()): Promise<boolean> {
    const entry = await this.entry(botId)
    return entry.teamBuilder && createdInLastDay(entry.created, now).length < entry.dailyCap
  }

  recordCreated(botId: string, now = Date.now()): Promise<void> {
    return this.change(botId, (entry) => ({
      ...entry,
      created: [...createdInLastDay(entry.created, now), now]
    }))
  }

  setGroup(botId: string, groupId: string): Promise<void> {
    return this.change(botId, (entry) => ({ ...entry, groupId }))
  }
}
