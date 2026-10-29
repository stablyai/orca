import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { GatewayCheckpoint } from './discord-gateway-session.js'

// The one checkpoint row.
const SLOT = 1

export async function loadCheckpoint(database: CloudDatabase): Promise<GatewayCheckpoint | null> {
  const [row] = await database.query(
    'SELECT session_id, resume_url, sequence FROM connector_discord_gateway WHERE slot = ?',
    [SLOT]
  )
  return row
    ? {
        sessionId: String(row.session_id),
        resumeURL: String(row.resume_url),
        sequence: Number(row.sequence)
      }
    : null
}

export async function saveCheckpoint(
  transaction: CloudDatabase,
  checkpoint: GatewayCheckpoint
): Promise<void> {
  await transaction.query(
    `INSERT INTO connector_discord_gateway (slot, session_id, resume_url, sequence)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (slot) DO UPDATE SET session_id = excluded.session_id,
       resume_url = excluded.resume_url, sequence = excluded.sequence`,
    [SLOT, checkpoint.sessionId, checkpoint.resumeURL, checkpoint.sequence]
  )
}
