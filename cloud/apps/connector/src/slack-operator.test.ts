import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryConnectorDatabase } from './connector-database.js'
import { findIdentity } from './connector-identities.js'
import { SlackInstalls } from './slack-installs.js'
import { runSlackOperator } from './slack-operator.js'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

async function setup(secret = 'xoxb-1') {
  const database = await openInMemoryConnectorDatabase()
  closers.push(() => database.close())
  const tokenKey = randomBytes(32)
  const run = (...argv: string[]) =>
    runSlackOperator(argv, {
      database,
      tokenKey,
      readSecret: async () => `${secret}\n`,
      now: () => 1
    })
  return { database, tokenKey, run }
}

describe('Slack operator command', () => {
  it('stores the bot token sealed, and pauses or resumes the workspace', async () => {
    const { database, tokenKey, run } = await setup()
    expect(await run('install', '--team', 'T1', '--bot-user', 'UBOT')).toBe(
      'Saved the bot token for T1.'
    )
    const [row] = await database.query('SELECT bot_token FROM connector_slack_installs')
    expect(String(row?.bot_token)).not.toContain('xoxb')
    const installs = new SlackInstalls(tokenKey)
    expect(await installs.botToken(database, 'T1')).toBe('xoxb-1')
    expect(await run('pause', '--team', 'T1')).toBe('Paused T1.')
    expect(await installs.find(database, 'T1')).toEqual({
      teamId: 'T1',
      botUserId: 'UBOT',
      paused: true
    })
    await expect(run('resume', '--team', 'T2')).rejects.toThrow('T2 is not installed')
  })

  it('refuses something that is not a bot token or a Slack id', async () => {
    await expect(
      (await setup('xoxp-user')).run('install', '--team', 'T1', '--bot-user', 'UBOT')
    ).rejects.toThrow('bot token')
    await expect(
      (await setup()).run('install', '--team', 't1', '--bot-user', 'UBOT')
    ).rejects.toThrow('--team')
  })

  it('links a Slack user to an account with machine-choice defaults', async () => {
    const { database, run } = await setup()
    await run(
      'link',
      '--team',
      'T1',
      '--user',
      'U1',
      '--account',
      'user-1',
      '--default-host',
      'user-1:machine',
      '--default-project',
      'stablyai/orca',
      '--channel-project',
      'C1=web'
    )
    expect(
      await findIdentity(database, { source: 'slack', workspaceId: 'T1', userId: 'U1' })
    ).toEqual({
      accountId: 'user-1',
      defaultHostId: 'user-1:machine',
      defaultProject: 'stablyai/orca',
      containerProjects: { C1: 'web' }
    })
    expect(await run('hosts', '--account', 'user-1')).toBe(
      'No machines have connected for this account.'
    )
  })
})
