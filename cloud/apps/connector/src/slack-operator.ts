import { parseArgs } from 'node:util'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import { describeAccountHosts } from './connector-hosts.js'
import { LINK_OPTIONS, linkIdentity, required } from './operator-link.js'
import { SlackApps } from './slack-apps.js'
import { SlackInstalls } from './slack-installs.js'

// Slack ids are upper-case letters and digits; anything else is a typo, and a bot user id ends up
// in a pattern.
const SLACK_ID = /^[A-Z0-9]+$/
const CLIENT_ID = /^\d+\.\d+$/

// Read from stdin as one JSON object, so no secret is ever a command-line argument.
const AppSecretsSchema = z
  .object({ clientSecret: z.string().min(1), signingSecret: z.string().min(1) })
  .strict()

export const SLACK_OPERATOR_USAGE = `Usage:
  register-app --app-id <A…> --client-id <id>
       stdin: {"clientSecret": "…", "signingSecret": "…"}
  install --team <T…> --bot-user <U…> --app-id <A…>     bot token is read from stdin
  pause --team <T…> | resume --team <T…>
  link --team <T…> --user <U…> --account <orca account id>
       [--default-host <host id>] [--default-project <name or owner/name>]
       [--channel-project <C…>=<name or owner/name>]…
  hosts --account <orca account id>`

function slackId(value: string | undefined, flag: string): string {
  if (!value || !SLACK_ID.test(value)) {
    throw new Error(`--${flag} needs a Slack id`)
  }
  return value
}

// Dogfood seeding (no OAuth install or Slack sign-in yet): an app Orca serves and the workspace it
// is installed in, and which Orca account each Slack user is, with their machine-choice defaults.
export async function runSlackOperator(
  argv: string[],
  deps: {
    database: CloudDatabase
    tokenKey?: Buffer
    readSecret: () => Promise<string>
    now: () => number
  }
): Promise<string> {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      ...LINK_OPTIONS,
      team: { type: 'string' },
      'bot-user': { type: 'string' },
      'app-id': { type: 'string' },
      'client-id': { type: 'string' }
    }
  })
  const tokenKey = () => {
    if (!deps.tokenKey) {
      throw new Error('ORCA_CONNECTOR_SLACK_TOKEN_KEY is required')
    }
    return deps.tokenKey
  }
  const installs = () => new SlackInstalls(tokenKey())
  switch (command) {
    case 'register-app': {
      const appId = slackId(values['app-id'], 'app-id')
      const clientId = values['client-id']
      if (!clientId || !CLIENT_ID.test(clientId)) {
        throw new Error('--client-id needs a Slack client id')
      }
      let secrets: z.infer<typeof AppSecretsSchema>
      try {
        secrets = AppSecretsSchema.parse(JSON.parse(await deps.readSecret()))
      } catch {
        // Never echo the parse error: it can quote the secrets.
        throw new Error('stdin must be {"clientSecret": "…", "signingSecret": "…"}')
      }
      const app = { appId, clientId, ...secrets }
      if (!(await new SlackApps(tokenKey()).register(deps.database, app, deps.now()))) {
        throw new Error(`${appId} is already registered`)
      }
      return `Registered ${appId}.`
    }
    // Also binds a workspace installed before apps were rows to its app.
    case 'install': {
      const teamId = slackId(values.team, 'team')
      const botUserId = slackId(values['bot-user'], 'bot-user')
      const appId = slackId(values['app-id'], 'app-id')
      const botToken = (await deps.readSecret()).trim()
      if (!botToken.startsWith('xoxb-')) {
        throw new Error('stdin must be a bot token (xoxb-…)')
      }
      if (!(await new SlackApps(tokenKey()).exists(deps.database, appId))) {
        throw new Error(`${appId} is not registered`)
      }
      const install = { teamId, appId, botUserId, botToken }
      if (!(await installs().save(deps.database, install, deps.now()))) {
        throw new Error(`${teamId} already has another Orca app installed`)
      }
      return `Saved the bot token for ${teamId}, installed through ${appId}.`
    }
    case 'pause':
    case 'resume': {
      const teamId = slackId(values.team, 'team')
      if (!(await installs().setPaused(deps.database, teamId, command === 'pause'))) {
        throw new Error(`${teamId} is not installed`)
      }
      return command === 'pause' ? `Paused ${teamId}.` : `Resumed ${teamId}.`
    }
    case 'link':
      return await linkIdentity(
        deps.database,
        { source: 'slack', workspaceId: slackId(values.team, 'team'), values, checkId: slackId },
        deps.now()
      )
    case 'hosts':
      return await describeAccountHosts(deps.database, required(values.account, 'account'))
    default:
      throw new Error(SLACK_OPERATOR_USAGE)
  }
}
