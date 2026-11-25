import { describe, expect, it } from 'vitest'
import { makeTestBot } from '../bot.test-fixture'
import {
  botShareGitHubState,
  botShareGoogleStatus,
  botShareLinearState,
  botShareTools
} from './bot-share-connector-views'

describe('a teammate’s view of the shared bot’s connectors', () => {
  it('keeps where the bot is connected and drops install links, keys and other bots', () => {
    expect(
      botShareLinearState(
        {
          installUrl: 'https://linear.app/install?token=SECRET',
          workspaces: [
            {
              workspaceId: 'w1',
              name: 'Acme',
              urlKey: 'acme',
              installed: true,
              userId: 'u1',
              userName: 'Owner',
              defaultBotId: 'bot-other'
            }
          ]
        },
        'bot-shared'
      )
    ).toEqual({
      installUrl: '',
      workspaces: [
        {
          workspaceId: 'w1',
          name: 'Acme',
          urlKey: 'acme',
          installed: true,
          userId: 'u1',
          userName: 'Owner',
          defaultBotId: null
        }
      ]
    })

    expect(
      botShareGitHubState(
        {
          installUrl: 'https://github.com/apps/orca/installations/new?state=SECRET',
          account: { userId: '1', login: 'owner' },
          accounts: [
            { userId: '1', login: 'owner', installations: ['7'], defaultBotId: 'bot-shared' }
          ],
          installations: [{ installationId: '7', accountLogin: 'acme', repositories: null }],
          defaultBotId: 'bot-other'
        },
        'bot-shared'
      )
    ).toEqual({
      installUrl: '',
      account: { userId: '1', login: 'owner' },
      accounts: [{ userId: '1', login: 'owner', installations: ['7'], defaultBotId: 'bot-shared' }],
      installations: [{ installationId: '7', accountLogin: 'acme', repositories: null }],
      defaultBotId: null
    })

    const shared = makeTestBot({ id: 'bot-shared' })
    expect(
      botShareGoogleStatus(
        {
          client: { clientId: 'CLIENT-ID', projectId: 'PROJECT', source: 'imported', savedAt: 5 },
          clientKey: { state: 'ok', checkedAt: 5 } as never,
          accounts: [],
          defaultAccount: null,
          bots: [
            { id: 'bot-shared', name: 'Shared' },
            { id: 'bot-other', name: 'Other' }
          ]
        },
        shared
      )
    ).toEqual({
      client: { clientId: '', source: 'imported', savedAt: 5 },
      accounts: [],
      defaultAccount: null,
      bots: [{ id: 'bot-shared', name: 'Shared' }]
    })

    expect(
      botShareTools({
        agent: 'claude',
        own: [{ name: 'db', detail: 'npx db-mcp --key=SECRET', remote: false }],
        inherited: [{ name: 'fs' }]
      })
    ).toEqual({
      agent: 'claude',
      own: [{ name: 'db', detail: '', remote: false }],
      inherited: [{ name: 'fs' }]
    })
  })
})
