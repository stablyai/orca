import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { MEMBERSHIP_TTL_MS } from './slack-members.js'
import { slackText } from './slack-text.js'

// Decisions §1 / 11: a teammate's message in someone else's conversation is kept for that owner's
// next delivery, never delivered as a turn of its own.
export async function keepTeammateContext(
  transaction: CloudDatabase,
  externalId: string,
  message: { ts: string; teamId: string; userId: string; text: string },
  now: number
): Promise<void> {
  await transaction.query(
    `INSERT INTO connector_thread_context
     (external_id, ts, team_id, author_user_id, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (external_id, ts) DO NOTHING`,
    [externalId, message.ts, message.teamId, message.userId, message.text, now]
  )
}

// Teammates' messages go along once their author is freshly confirmed a full member of the
// workspace; the rest wait for the membership check.
export async function withTeammateContext(
  transaction: CloudDatabase,
  externalId: string,
  ownerText: string,
  now: number
): Promise<string> {
  const rows = await transaction.query(
    `SELECT c.ts, c.text, u.display_name FROM connector_thread_context c
     JOIN connector_slack_users u
       ON u.team_id = c.team_id AND u.slack_user_id = c.author_user_id
     WHERE c.external_id = ? AND u.membership = 'member' AND u.checked_at >= ? ORDER BY c.ts`,
    [externalId, now - MEMBERSHIP_TTL_MS]
  )
  if (rows.length === 0) {
    return ownerText
  }
  await transaction.query(
    `DELETE FROM connector_thread_context
     WHERE external_id = ? AND ts IN (${rows.map(() => '?').join(', ')})`,
    [externalId, ...rows.map((row) => row.ts)]
  )
  return slackText.teammateContext(
    rows.map((row) => ({ name: String(row.display_name), text: String(row.text) })),
    ownerText
  )
}
