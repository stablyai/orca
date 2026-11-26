import { describe, expect, it } from 'vitest'
import type { ConnectorBotSlackStateResponse } from '../../../shared/connector-bot-slack-contract'
import type { ConnectorGitHubState } from '../../../shared/connector-bot-github-contract'
import type { ConnectorLinearState } from '../../../shared/connector-bot-linear-contract'
import type { GoogleStatusView } from '../../../shared/google/google-connect-types'
import type { BotTools } from '../../../shared/bot-tools'
import type { ComposioStatus } from '../../../shared/composio/composio-apps'
import { makeTestBot } from '../bot.test-fixture'
import {
  botShareComposioStatus,
  botShareGitHubState,
  botShareGoogleStatus,
  botShareLinearState,
  botShareSlackState,
  botShareTools
} from './bot-share-connector-views'

// Every value a teammate must not read says SECRET, including a field no view knows yet.
const FUTURE = { futureField: 'SECRET future field' }
const leaks = (view: unknown): boolean => JSON.stringify(view).includes('SECRET')

describe('a teammate’s view of the shared bot’s connectors', () => {
  it('reads Google accounts by label and which services work, never the owner’s app or project', () => {
    const view = botShareGoogleStatus(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries an unknown field on purpose.
      {
        client: {
          clientId: 'SECRET-client.apps.googleusercontent.com',
          projectId: 'SECRET-project',
          source: 'imported',
          savedAt: 5
        },
        clientKey: 'works',
        accounts: [
          {
            email: 'owner@example.com',
            status: 'connected',
            googleError: 'SECRET google words',
            reason: 'SECRET reason',
            services: [
              { service: 'gmail', state: 'ready' },
              {
                service: 'calendar',
                state: 'api-disabled',
                detail: 'SECRET detail',
                enableUrl: 'https://console.cloud.google.com/apis?project=SECRET-project'
              }
            ],
            connectedAt: 1,
            app: { clientId: 'SECRET-client', projectId: 'SECRET-project' },
            ...FUTURE
          }
        ],
        defaultAccount: 'owner@example.com',
        bots: [
          { id: 'bot-shared', name: 'Shared' },
          { id: 'bot-other', name: 'SECRET other bot' }
        ],
        ...FUTURE
      } as GoogleStatusView,
      makeTestBot({ id: 'bot-shared' })
    )
    expect(leaks(view)).toBe(false)
    expect(view.accounts).toEqual([
      {
        email: 'owner@example.com',
        status: 'connected',
        services: [
          { service: 'gmail', state: 'ready' },
          { service: 'calendar', state: 'api-disabled' }
        ],
        connectedAt: 1
      }
    ])
    expect(view.bots).toEqual([{ id: 'bot-shared', name: 'Shared' }])
  })

  it('reads where Slack, Linear and GitHub are connected, without install links or other agents', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries unknown fields on purpose.
    const slack = {
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'U-bot',
      installerUserId: 'U-owner',
      teamName: 'Acme',
      ...FUTURE,
      teams: [{ state: 'created', teamId: 'T2', appId: 'A2', ...FUTURE }]
    } as ConnectorBotSlackStateResponse
    expect(leaks(botShareSlackState(slack))).toBe(false)
    expect(botShareSlackState(slack)).toMatchObject({ state: 'installed', teamName: 'Acme' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries unknown fields on purpose.
    const linear = {
      installUrl: 'https://linear.app/install?token=SECRET',
      workspaces: [
        {
          workspaceId: 'w1',
          name: 'Acme',
          urlKey: 'acme',
          installed: true,
          userId: 'u1',
          userName: 'Owner',
          defaultBotId: 'SECRET-bot-other',
          ...FUTURE
        }
      ],
      ...FUTURE
    } as ConnectorLinearState
    expect(leaks(botShareLinearState(linear, 'bot-shared'))).toBe(false)
    expect(botShareLinearState(linear, 'bot-shared').workspaces[0]).toMatchObject({
      name: 'Acme',
      defaultBotId: null
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries unknown fields on purpose.
    const github = {
      installUrl: 'https://github.com/apps/orca/installations/new?state=SECRET',
      account: { userId: '1', login: 'owner', ...FUTURE },
      accounts: [
        { userId: '1', login: 'owner', installations: ['7'], defaultBotId: 'bot-shared', ...FUTURE }
      ],
      installations: [
        { installationId: '7', accountLogin: 'acme', repositories: [{ fullName: 'acme/app' }] }
      ],
      defaultBotId: 'SECRET-bot-other',
      ...FUTURE
    } as ConnectorGitHubState
    expect(leaks(botShareGitHubState(github, 'bot-shared'))).toBe(false)
    expect(botShareGitHubState(github, 'bot-shared')).toMatchObject({
      accounts: [{ login: 'owner', defaultBotId: 'bot-shared' }],
      installations: [{ accountLogin: 'acme', repositories: [{ fullName: 'acme/app' }] }],
      defaultBotId: null
    })
  })

  it('reads tools by name and sign-in state, and Composio by whether it works', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries unknown fields on purpose.
    const tools = {
      agent: 'claude',
      own: [
        {
          name: 'db',
          detail: 'npx db-mcp --key=SECRET',
          remote: false,
          signIn: { state: 'signed-in', limited: false, ...FUTURE },
          ...FUTURE
        }
      ],
      inherited: [{ name: 'fs', ...FUTURE }]
    } as BotTools
    expect(leaks(botShareTools(tools))).toBe(false)
    expect(botShareTools(tools).own).toEqual([
      { name: 'db', detail: '', remote: false, signIn: { state: 'signed-in', limited: false } }
    ])

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries an unknown field on purpose.
    const composio = { key: 'ok', limit: null, added: true, ...FUTURE } as ComposioStatus
    expect(botShareComposioStatus(composio)).toEqual({ key: 'ok', limit: null, added: true })
  })
})
