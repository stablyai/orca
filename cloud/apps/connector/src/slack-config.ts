import { z } from 'zod'

export type SlackConfig = {
  // The route Slack used before apps were rows: one env secret, served only for allowlisted
  // workspaces. Removed once staging's app posts to its own URL.
  legacy?: { signingSecret: string; teamIds: ReadonlySet<string> }
  // Cloud-wide kill switch: ingress still answers 200 but queues nothing.
  paused: boolean
  // AES-256 key (from Secret Manager) sealing every stored Slack secret: bot tokens and each app's
  // client and signing secrets.
  tokenKey: Buffer
}

const SlackEnvSchema = z.object({
  ORCA_CONNECTOR_SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  ORCA_CONNECTOR_SLACK_TEAM_IDS: z.string().min(1).optional(),
  ORCA_CONNECTOR_SLACK_PAUSED: z.enum(['true', 'false']).default('false'),
  ORCA_CONNECTOR_SLACK_TOKEN_KEY: z.string().min(1).optional()
})

export function decodeSlackTokenKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('ORCA_CONNECTOR_SLACK_TOKEN_KEY must be 32 bytes in canonical base64')
  }
  return key
}

// Slack is off without a token key; which apps and workspaces it serves are rows. The legacy
// signing secret, if set, still needs its allowlist.
export function parseSlackConfig(env: Record<string, string | undefined>): SlackConfig | undefined {
  const parsed = SlackEnvSchema.parse(env)
  const secret = parsed.ORCA_CONNECTOR_SLACK_SIGNING_SECRET
  if (parsed.ORCA_CONNECTOR_SLACK_TOKEN_KEY === undefined) {
    if (secret !== undefined) {
      throw new Error('Slack needs ORCA_CONNECTOR_SLACK_TOKEN_KEY')
    }
    return undefined
  }
  const teamIds = (parsed.ORCA_CONNECTOR_SLACK_TEAM_IDS ?? '')
    .split(',')
    .map((team) => team.trim())
    .filter((team) => team.length > 0)
  if (secret !== undefined && teamIds.length === 0) {
    throw new Error('The legacy Slack signing secret needs ORCA_CONNECTOR_SLACK_TEAM_IDS')
  }
  return {
    ...(secret === undefined ? {} : { legacy: { signingSecret: secret, teamIds: new Set(teamIds) } }),
    paused: parsed.ORCA_CONNECTOR_SLACK_PAUSED === 'true',
    tokenKey: decodeSlackTokenKey(parsed.ORCA_CONNECTOR_SLACK_TOKEN_KEY)
  }
}
