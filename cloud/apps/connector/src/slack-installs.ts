import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CloudDatabase } from '@orca-cloud/cloud-database'

export type SlackInstall = { teamId: string; botUserId: string; paused: boolean }

// AES-256-GCM bound to the team id, so a sealed token copied to another row won't open.
export function sealBotToken(key: Buffer, teamId: string, token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(teamId))
  const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return ['v1', ...[iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64'))].join(
    '.'
  )
}

export function openBotToken(key: Buffer, teamId: string, sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('unreadable sealed bot token')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    .setAAD(Buffer.from(teamId))
    .setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8'
  )
}

// One row per Slack workspace, written by the operator command (no OAuth install in v1).
export class SlackInstalls {
  constructor(private readonly tokenKey: Buffer) {}

  async find(database: CloudDatabase, teamId: string): Promise<SlackInstall | null> {
    const [row] = await database.query(
      'SELECT bot_user_id, paused FROM connector_slack_installs WHERE team_id = ?',
      [teamId]
    )
    return row
      ? { teamId, botUserId: String(row.bot_user_id), paused: Number(row.paused) === 1 }
      : null
  }

  async botToken(database: CloudDatabase, teamId: string): Promise<string | null> {
    const [row] = await database.query(
      'SELECT bot_token FROM connector_slack_installs WHERE team_id = ?',
      [teamId]
    )
    if (!row) {
      return null
    }
    // Sealed under another key or corrupted: as good as no install.
    try {
      return openBotToken(this.tokenKey, teamId, String(row.bot_token))
    } catch {
      return null
    }
  }

  async save(
    database: CloudDatabase,
    install: { teamId: string; botUserId: string; botToken: string },
    now: number
  ): Promise<void> {
    await database.query(
      `INSERT INTO connector_slack_installs (team_id, bot_user_id, bot_token, paused, installed_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (team_id) DO UPDATE SET bot_user_id = excluded.bot_user_id,
         bot_token = excluded.bot_token, installed_at = excluded.installed_at`,
      [
        install.teamId,
        install.botUserId,
        sealBotToken(this.tokenKey, install.teamId, install.botToken),
        now
      ]
    )
  }

  async setPaused(database: CloudDatabase, teamId: string, paused: boolean): Promise<boolean> {
    const [result] = await database.query(
      'UPDATE connector_slack_installs SET paused = ? WHERE team_id = ?',
      [paused ? 1 : 0, teamId]
    )
    return Number(result?.changes ?? 0) > 0
  }
}
