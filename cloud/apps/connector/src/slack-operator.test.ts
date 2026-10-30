import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryConnectorDatabase } from './connector-database.js'
import { findIdentity } from './connector-identities.js'
import { SlackApps } from './slack-apps.js'
import { SlackInstalls } from './slack-installs.js'
import { sealSecret } from './slack-sealing.js'
import { runSlackOperator } from './slack-operator.js'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

const APP_SECRETS = JSON.stringify({ clientSecret: 'cs-1', signingSecret: 'ss-1' })
const REGISTER = ['register-app', '--app-id', 'A1', '--client-id', '1.2']
const INSTALL = ['install', '--team', 'T1', '--bot-user', 'UBOT', '--app-id', 'A1']

// register-app reads the app's secrets from stdin, install reads the bot token.
async function setup(stdin: { app?: string; bot?: string } = {}) {
  const database = await openInMemoryConnectorDatabase()
  closers.push(() => database.close())
  const tokenKey = randomBytes(32)
  const run = (...argv: string[]) =>
    runSlackOperator(argv, {
      database,
      tokenKey,
      readSecret: async () =>
        argv[0] === 'register-app' ? (stdin.app ?? APP_SECRETS) : (stdin.bot ?? 'xoxb-1\n'),
      now: () => 1
    })
  return { database, tokenKey, run }
}

describe('Slack operator command', () => {
  it('registers an app and installs it sealed, and pauses or resumes the workspace', async () => {
    const { database, tokenKey, run } = await setup()
    expect(await run(...REGISTER)).toBe('Registered A1.')
    expect(await run(...INSTALL)).toBe('Saved the bot token for T1, installed through A1.')
    const rows = await database.query(
      `SELECT a.client_secret, a.signing_secret, i.bot_token FROM connector_slack_apps a
       JOIN connector_slack_installs i ON i.app_id = a.app_id`
    )
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toMatch(/cs-1|ss-1|xoxb/)
    expect(await new SlackApps(tokenKey).signingSecret(database, 'A1')).toBe('ss-1')
    const installs = new SlackInstalls(tokenKey)
    expect(await installs.botToken(database, 'T1')).toBe('xoxb-1')
    expect(await run('pause', '--team', 'T1')).toBe('Paused T1.')
    expect(await installs.find(database, 'T1')).toEqual({
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UBOT',
      paused: true
    })
    await expect(run('resume', '--team', 'T2')).rejects.toThrow('T2 is not installed')
  })

  it('binds a workspace installed before apps were rows, keeping its sealed token readable', async () => {
    const { database, tokenKey, run } = await setup()
    // As the shipped install command left it: no app, the token sealed under the team id.
    await database.query(
      `INSERT INTO connector_slack_installs (team_id, bot_user_id, bot_token, paused, installed_at)
       VALUES ('T1', 'UBOT', ?, 0, 1)`,
      [sealSecret(tokenKey, 'T1', 'xoxb-old')]
    )
    const installs = new SlackInstalls(tokenKey)
    expect(await installs.find(database, 'T1')).toMatchObject({ appId: null })
    expect(await installs.botToken(database, 'T1')).toBe('xoxb-old')
    await run(...REGISTER)
    await run(...INSTALL)
    expect(await installs.find(database, 'T1')).toMatchObject({ appId: 'A1' })
    expect(await installs.botToken(database, 'T1')).toBe('xoxb-1')
  })

  it('keeps one Orca app per workspace, and never replaces an app’s secrets', async () => {
    const { database, tokenKey, run } = await setup()
    await run(...REGISTER)
    await run(...INSTALL)
    await run('register-app', '--app-id', 'A2', '--client-id', '3.4')
    await expect(
      run('install', '--team', 'T1', '--bot-user', 'U2', '--app-id', 'A2')
    ).rejects.toThrow('T1 already has another Orca app installed')
    expect(await new SlackInstalls(tokenKey).find(database, 'T1')).toMatchObject({
      appId: 'A1',
      botUserId: 'UBOT'
    })
    await expect(run(...REGISTER)).rejects.toThrow('A1 is already registered')
    await expect(
      run('install', '--team', 'T2', '--bot-user', 'U2', '--app-id', 'A9')
    ).rejects.toThrow('A9 is not registered')
  })

  it('refuses bad stdin without echoing it, and bad ids', async () => {
    const leaked = JSON.stringify({ clientSecret: 'cs-1', signingSecret: 'ss-1', extra: 'x-secret' })
    const refused = (await setup({ app: leaked })).run(...REGISTER)
    await expect(refused).rejects.toThrow('stdin must be')
    await expect(refused).rejects.not.toThrow('x-secret')
    await expect((await setup({ app: 'not json' })).run(...REGISTER)).rejects.toThrow('stdin must be')
    const notBot = await setup({ bot: 'xoxp-user' })
    await notBot.run(...REGISTER)
    await expect(notBot.run(...INSTALL)).rejects.toThrow('bot token')
    await expect(
      (await setup()).run('register-app', '--app-id', 'A1', '--client-id', 'x')
    ).rejects.toThrow('--client-id')
    await expect(
      (await setup()).run('install', '--team', 't1', '--bot-user', 'U', '--app-id', 'A1')
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
