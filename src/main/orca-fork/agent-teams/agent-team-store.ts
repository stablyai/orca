// orca-fork: each bot's team settings on its host, beside the profile and outside every bot's home, so
// no bot can grant itself the permission.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as z from 'zod'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
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
  private bots: Record<string, TeamEntry> | null = null

  constructor(private readonly path: () => string) {}

  private load(): Record<string, TeamEntry> {
    if (this.bots) {
      return this.bots
    }
    try {
      const parsed = TeamFileSchema.safeParse(JSON.parse(readFileSync(this.path(), 'utf8')))
      this.bots = parsed.success ? parsed.data.bots : {}
    } catch {
      this.bots = {}
    }
    return this.bots
  }

  private write(botId: string, entry: TeamEntry): void {
    const bots = { ...this.load(), [botId]: entry }
    writeFileAtomically(this.path(), `${JSON.stringify({ version: 1, bots }, null, 2)}\n`, {
      mode: 0o600
    })
    this.bots = bots
  }

  entry(botId: string): TeamEntry {
    return this.load()[botId] ?? OFF
  }

  view(botId: string, now = Date.now()): AgentTeamView {
    const { teamBuilder, dailyCap, created, groupId } = this.entry(botId)
    return {
      teamBuilder,
      dailyCap,
      createdToday: createdInLastDay(created, now).length,
      groupId: groupId ?? null
    }
  }

  set(botId: string, settings: Partial<AgentTeamSettings>): void {
    this.write(botId, { ...this.entry(botId), ...settings })
  }

  /** Whether it may create one more bot now: team builder and under its daily cap. */
  mayCreate(botId: string, now = Date.now()): boolean {
    const entry = this.entry(botId)
    return entry.teamBuilder && createdInLastDay(entry.created, now).length < entry.dailyCap
  }

  recordCreated(botId: string, now = Date.now()): void {
    const entry = this.entry(botId)
    this.write(botId, { ...entry, created: [...createdInLastDay(entry.created, now), now] })
  }

  setGroup(botId: string, groupId: string): void {
    this.write(botId, { ...this.entry(botId), groupId })
  }
}
