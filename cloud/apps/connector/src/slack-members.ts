import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { SlackInstalls } from './slack-installs.js'
import type { SlackWebApi } from './slack-web-api.js'

export type SlackMembership = 'member' | 'guest' | 'other'

// A cached membership check is trusted this long before users.info is asked again.
const MEMBERSHIP_TTL_MS = 24 * 60 * 60_000
const MEMBER_CHECKS_PER_PASS = 20

// Slack may send absent, null or empty profile names; none of that bears on membership.
const UserInfoSchema = z.object({ user: z.looseObject({}) })
const UserNamesSchema = z.object({
  profile: z
    .looseObject({ display_name: z.string().nullish(), real_name: z.string().nullish() })
    .nullish(),
  name: z.string().nullish()
})

// users.info → full member of this workspace, guest, or anything else (other company, bot, gone).
export function membershipOf(user: Record<string, unknown>, teamId: string): SlackMembership {
  if (user.deleted === true || user.is_bot === true || user.team_id !== teamId) {
    return 'other'
  }
  return user.is_restricted === true || user.is_ultra_restricted === true ? 'guest' : 'member'
}

// The membership cache (decisions §1: only full members' words reach an agent), filled from
// users.info off the ingress path.
export class SlackMembers {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      installs: SlackInstalls
      api: SlackWebApi
      now: () => number
    }
  ) {}

  // Display names of the given users who are freshly confirmed full members; asks Slack for the
  // rest. A user Slack can't answer for right now is left out.
  async memberNames(teamId: string, userIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    for (const userId of new Set(userIds)) {
      const known = await this.cached(teamId, userId)
      const checked = known ?? (await this.check(teamId, userId))
      if (checked?.membership === 'member') {
        names.set(userId, checked.name)
      }
    }
    return names
  }

  // Display names of the given users already confirmed full members, from the cache only, so a
  // routing transaction never waits on Slack.
  async trustedNames(
    transaction: CloudDatabase,
    teamId: string,
    userIds: string[]
  ): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) {
      return new Map()
    }
    const rows = await transaction.query(
      `SELECT slack_user_id, display_name FROM connector_slack_users
       WHERE team_id = ? AND membership = 'member' AND checked_at >= ?
         AND slack_user_id IN (${unique.map(() => '?').join(', ')})`,
      [teamId, this.deps.now() - MEMBERSHIP_TTL_MS, ...unique]
    )
    return new Map(rows.map((row) => [String(row.slack_user_id), String(row.display_name)]))
  }

  // Checks teammates whose messages wait as context, so the owner's next message can carry them.
  async checkContextAuthors(): Promise<void> {
    const authors = await this.deps.database.query(
      `SELECT DISTINCT c.workspace_id, c.author_id FROM connector_thread_context c
       LEFT JOIN connector_slack_users u
         ON u.team_id = c.workspace_id AND u.slack_user_id = c.author_id
       WHERE c.source = 'slack' AND (u.slack_user_id IS NULL OR u.checked_at < ?) LIMIT ?`,
      [this.deps.now() - MEMBERSHIP_TTL_MS, MEMBER_CHECKS_PER_PASS]
    )
    for (const author of authors) {
      await this.check(String(author.workspace_id), String(author.author_id))
    }
  }

  private async cached(
    teamId: string,
    userId: string
  ): Promise<{ membership: string; name: string } | null> {
    const [row] = await this.deps.database.query(
      `SELECT membership, display_name FROM connector_slack_users
       WHERE team_id = ? AND slack_user_id = ? AND checked_at >= ?`,
      [teamId, userId, this.deps.now() - MEMBERSHIP_TTL_MS]
    )
    return row ? { membership: String(row.membership), name: String(row.display_name) } : null
  }

  private async check(
    teamId: string,
    userId: string
  ): Promise<{ membership: SlackMembership; name: string } | null> {
    const { database, installs, api, now } = this.deps
    const token = await installs.botToken(database, teamId)
    const result = token === null ? null : await api(token, 'users.info', { user: userId })
    if (result?.kind !== 'ok' && result?.kind !== 'failed') {
      return null
    }
    const info = result.kind === 'ok' ? UserInfoSchema.safeParse(result.body) : undefined
    const user = info?.success ? info.data.user : undefined
    const names = UserNamesSchema.safeParse(user).data
    const checked = {
      membership: user ? membershipOf(user, teamId) : ('other' as const),
      name: names?.profile?.display_name || names?.profile?.real_name || names?.name || userId
    }
    await database.query(
      `INSERT INTO connector_slack_users
       (team_id, slack_user_id, membership, display_name, checked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (team_id, slack_user_id) DO UPDATE SET membership = excluded.membership,
         display_name = excluded.display_name, checked_at = excluded.checked_at`,
      [teamId, userId, checked.membership, checked.name, now()]
    )
    return checked
  }
}
