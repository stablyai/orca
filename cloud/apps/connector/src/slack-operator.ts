import { parseArgs } from 'node:util'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { describeAccountHosts } from './connector-hosts.js'
import { LINK_OPTIONS, linkIdentity, required } from './operator-link.js'
import { SlackInstalls } from './slack-installs.js'

// Slack ids are upper-case letters and digits; anything else is a typo, and a bot user id ends up
// in a pattern.
const SLACK_ID = /^[A-Z0-9]+$/

export const SLACK_OPERATOR_USAGE = `Usage:
  install --team <T…> --bot-user <U…>     bot token is read from stdin
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

// Dogfood seeding (no OAuth install or Slack sign-in in v1): one workspace's bot token, and which
// Orca account each Slack user is, with their machine-choice defaults.
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
      'bot-user': { type: 'string' }
    }
  })
  const installs = () => {
    if (!deps.tokenKey) {
      throw new Error('ORCA_CONNECTOR_SLACK_TOKEN_KEY is required')
    }
    return new SlackInstalls(deps.tokenKey)
  }
  switch (command) {
    case 'install': {
      const teamId = slackId(values.team, 'team')
      const botUserId = slackId(values['bot-user'], 'bot-user')
      const botToken = (await deps.readSecret()).trim()
      if (!botToken.startsWith('xoxb-')) {
        throw new Error('stdin must be a bot token (xoxb-…)')
      }
      await installs().save(deps.database, { teamId, botUserId, botToken }, deps.now())
      return `Saved the bot token for ${teamId}.`
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
