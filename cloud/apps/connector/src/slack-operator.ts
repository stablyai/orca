import { parseArgs } from 'node:util'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { saveSlackIdentity } from './slack-identities.js'
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

function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`--${flag} is required`)
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
      team: { type: 'string' },
      'bot-user': { type: 'string' },
      user: { type: 'string' },
      account: { type: 'string' },
      'default-host': { type: 'string' },
      'default-project': { type: 'string' },
      'channel-project': { type: 'string', multiple: true }
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
    case 'link': {
      const channelProjects = Object.fromEntries(
        (values['channel-project'] ?? []).map((entry) => {
          const [channel, project] = entry.split('=', 2)
          return [slackId(channel, 'channel-project'), required(project, 'channel-project')]
        })
      )
      const teamId = slackId(values.team, 'team')
      const slackUserId = slackId(values.user, 'user')
      await saveSlackIdentity(
        deps.database,
        {
          teamId,
          slackUserId,
          accountId: required(values.account, 'account'),
          defaultHostId: values['default-host'] ?? null,
          defaultProject: values['default-project'] ?? null,
          channelProjects
        },
        deps.now()
      )
      return `Linked ${slackUserId} in ${teamId}.`
    }
    case 'hosts': {
      const rows = await deps.database.query(
        `SELECT host_id, host_name, orca_version, last_seen_at FROM connector_hosts
         WHERE account_id = ? ORDER BY last_seen_at DESC`,
        [required(values.account, 'account')]
      )
      return rows.length === 0
        ? 'No machines have connected for this account.'
        : rows
            .map(
              (row) =>
                `${String(row.host_id)}  ${String(row.host_name)}  Orca ${String(row.orca_version)}  last seen ${new Date(Number(row.last_seen_at)).toISOString()}`
            )
            .join('\n')
    }
    default:
      throw new Error(SLACK_OPERATOR_USAGE)
  }
}
