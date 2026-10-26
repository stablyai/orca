import { z } from 'zod'

export type SlackConfig = {
  signingSecret: string
  // Q20 allowlist: events from any other workspace are acknowledged and ignored.
  teamIds: ReadonlySet<string>
  // Cloud-wide kill switch: ingress still answers 200 but queues nothing.
  paused: boolean
  // AES-256 key (from Secret Manager) sealing the stored bot tokens.
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

// Slack is off without a signing secret; with one, the allowlist and token key are required too.
export function parseSlackConfig(env: Record<string, string | undefined>): SlackConfig | undefined {
  const parsed = SlackEnvSchema.parse(env)
  const secret = parsed.ORCA_CONNECTOR_SLACK_SIGNING_SECRET
  if (secret === undefined) {
    return undefined
  }
  const teamIds = (parsed.ORCA_CONNECTOR_SLACK_TEAM_IDS ?? '')
    .split(',')
    .map((team) => team.trim())
    .filter((team) => team.length > 0)
  if (teamIds.length === 0 || parsed.ORCA_CONNECTOR_SLACK_TOKEN_KEY === undefined) {
    throw new Error('Slack needs ORCA_CONNECTOR_SLACK_TEAM_IDS and ORCA_CONNECTOR_SLACK_TOKEN_KEY')
  }
  return {
    signingSecret: secret,
    teamIds: new Set(teamIds),
    paused: parsed.ORCA_CONNECTOR_SLACK_PAUSED === 'true',
    tokenKey: decodeSlackTokenKey(parsed.ORCA_CONNECTOR_SLACK_TOKEN_KEY)
  }
}
