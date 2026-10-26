import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'

// An operator-seeded link from a Slack user to an Orca account, with their machine-choice defaults.
export type SlackIdentity = {
  accountId: string
  defaultHostId: string | null
  defaultProject: string | null
  // Channel id → project name or remote; wins over defaultProject in that channel.
  channelProjects: Record<string, string>
}

const ChannelProjectsSchema = z.record(z.string(), z.string().min(1))

export async function findSlackIdentity(
  database: CloudDatabase,
  teamId: string,
  slackUserId: string
): Promise<SlackIdentity | null> {
  const [row] = await database.query(
    `SELECT account_id, default_host_id, default_project, channel_projects
     FROM connector_slack_identities WHERE team_id = ? AND slack_user_id = ?`,
    [teamId, slackUserId]
  )
  if (!row) {
    return null
  }
  return {
    accountId: String(row.account_id),
    defaultHostId: row.default_host_id === null ? null : String(row.default_host_id),
    defaultProject: row.default_project === null ? null : String(row.default_project),
    channelProjects: ChannelProjectsSchema.parse(JSON.parse(String(row.channel_projects)))
  }
}

export async function saveSlackIdentity(
  database: CloudDatabase,
  link: { teamId: string; slackUserId: string } & SlackIdentity,
  now: number
): Promise<void> {
  await database.query(
    `INSERT INTO connector_slack_identities
     (team_id, slack_user_id, account_id, default_host_id, default_project, channel_projects,
      linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id, slack_user_id) DO UPDATE SET account_id = excluded.account_id,
       default_host_id = excluded.default_host_id, default_project = excluded.default_project,
       channel_projects = excluded.channel_projects, linked_at = excluded.linked_at`,
    [
      link.teamId,
      link.slackUserId,
      link.accountId,
      link.defaultHostId,
      link.defaultProject,
      JSON.stringify(link.channelProjects),
      now
    ]
  )
}
