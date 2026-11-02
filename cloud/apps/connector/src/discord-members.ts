import type { CloudDatabase } from '@orca-cloud/cloud-database'

// Decisions §15: on Discord only people linked to an Orca account count as the same company; their
// words reach an agent, labelled with the name their own message carried.
export async function linkedDiscordUsers(
  database: CloudDatabase,
  guildId: string,
  userIds: string[]
): Promise<Set<string>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) {
    return new Set()
  }
  const rows = await database.query(
    `SELECT user_id FROM connector_identities
     WHERE source = 'discord' AND workspace_id = ? AND user_id IN (${unique.map(() => '?').join(', ')})`,
    [guildId, ...unique]
  )
  return new Set(rows.map((row) => String(row.user_id)))
}
