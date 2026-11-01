import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { openSecret, sealSecret } from './slack-sealing.js'

export type SlackAppCredentials = {
  appId: string
  clientId: string
  clientSecret: string
  signingSecret: string
}

// Bot tokens are sealed under their bare team id (the shipped format), so a purpose prefix keeps
// these from ever matching one.
export const appSecretAad = (secret: 'client' | 'signing', appId: string) =>
  `slack-${secret}-secret\0${appId}`

// One row per Slack app Orca serves: a company's own copy, or one registered by an operator. Its
// signing secret verifies the requests Slack sends to that app's own URLs.
export class SlackApps {
  constructor(private readonly tokenKey: Buffer) {}

  // Null for an unknown app. A row that won't open (another key, corrupted) throws: that is an
  // operator fault, not a bad request.
  async signingSecret(database: CloudDatabase, appId: string): Promise<string | null> {
    const [row] = await database.query(
      'SELECT signing_secret FROM connector_slack_apps WHERE app_id = ?',
      [appId]
    )
    return row
      ? openSecret(this.tokenKey, appSecretAad('signing', appId), String(row.signing_secret))
      : null
  }

  async exists(database: CloudDatabase, appId: string): Promise<boolean> {
    const [row] = await database.query('SELECT 1 AS found FROM connector_slack_apps WHERE app_id = ?', [
      appId
    ])
    return row !== undefined
  }

  // False when the app is already registered: replacing an app's secrets is its own operation,
  // never a side effect of registering again.
  async register(database: CloudDatabase, app: SlackAppCredentials, now: number): Promise<boolean> {
    const [result] = await database.query(
      `INSERT INTO connector_slack_apps (app_id, client_id, client_secret, signing_secret, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (app_id) DO NOTHING`,
      [
        app.appId,
        app.clientId,
        sealSecret(this.tokenKey, appSecretAad('client', app.appId), app.clientSecret),
        sealSecret(this.tokenKey, appSecretAad('signing', app.appId), app.signingSecret),
        now
      ]
    )
    return Number(result?.changes ?? 0) > 0
  }
}
