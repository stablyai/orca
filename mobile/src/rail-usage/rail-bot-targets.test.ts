import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import type { PhoneBot } from '../bots/host-bots-operations'
import type { HomeBots } from '../home/bots/home-bot-rows'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { homeRailBotsSource } from './rail-bot-targets'

function fakeBot(id: string, name: string): PhoneBot {
  return {
    id,
    name,
    folder: id,
    folderWorkspaceId: `folder-${id}`,
    avatar: null,
    avatarColor: undefined,
    avatarOutfit: undefined,
    paused: false,
    agent: 'claude',
    permissionMode: undefined,
    launch: undefined,
    notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false },
    members: [],
    slack: null,
    slackApps: undefined,
    linear: null,
    linearWorkspaces: undefined,
    github: null,
    google: undefined,
    lookAround: undefined,
    tidyUp: undefined,
    skillProjects: undefined,
    itemsStale: undefined,
    cancelledWaits: undefined,
    chatSessionId: null,
    offerAnswers: undefined,
    acceptedOffers: undefined,
    sharedFrom: undefined,
    createdAt: undefined,
    updatedAt: undefined
  }
}

describe('homeRailBotsSource', () => {
  it('combines enabled bots across paired computers and carries the Needs you count', () => {
    const clientA = { id: 'a' } as unknown as RpcClient
    const clientB = { id: 'b' } as unknown as RpcClient
    const bots: HomeBots = {
      rows: [],
      needsYou: 3,
      computers: [
        {
          key: 'host-a\nlocal',
          pairedHostId: 'host-a',
          executionHost: LOCAL_EXECUTION_HOST_ID,
          readAt: 100,
          mode: 'live',
          answer: {
            kind: 'bots',
            enabled: true,
            bots: [fakeBot('bot-1', 'Coordinator'), fakeBot('bot-2', 'Maintenance')],
            hideBotCreated: false,
            view: { sortBy: 'smart', hidePausedBots: false, hideSleepingWorkers: false },
            takesCreate: true,
            takesTemplates: true,
            waits: {},
            needsYou: { 'bot-1': 2 }
          }
        },
        {
          key: 'host-b\nlocal',
          pairedHostId: 'host-b',
          executionHost: LOCAL_EXECUTION_HOST_ID,
          readAt: 100,
          mode: 'live',
          answer: {
            kind: 'bots',
            enabled: true,
            bots: [fakeBot('bot-3', 'Wifi')],
            hideBotCreated: false,
            view: { sortBy: 'smart', hidePausedBots: false, hideSleepingWorkers: false },
            takesCreate: true,
            takesTemplates: true,
            waits: {},
            needsYou: { 'bot-3': 1 }
          }
        },
        {
          key: 'host-c\nlocal',
          pairedHostId: 'host-c',
          executionHost: LOCAL_EXECUTION_HOST_ID,
          readAt: 100,
          mode: 'live',
          answer: {
            kind: 'bots',
            enabled: false,
            bots: [fakeBot('bot-off', 'Disabled')],
            hideBotCreated: false,
            view: { sortBy: 'smart', hidePausedBots: false, hideSleepingWorkers: false },
            takesCreate: false,
            takesTemplates: false,
            waits: {},
            needsYou: {}
          }
        }
      ],
      labels: new Map([
        ['host-a\nlocal', 'Mac Studio'],
        ['host-b\nlocal', 'MacBook'],
        ['host-c\nlocal', 'Old Mac']
      ]),
      unavailable: [],
      listable: true,
      awaiting: false,
      activityByHost: new Map()
    }

    const source = homeRailBotsSource({
      bots,
      allClients: [
        { hostId: 'host-a', client: clientA },
        { hostId: 'host-b', client: clientB }
      ],
      hostStates: { 'host-a': 'connected', 'host-b': 'disconnected' },
      fallbackHostName: 'The computer'
    })

    expect(source.needsYou).toBe(3)
    expect(source.online).toBe(true)
    expect(source.loading).toBe(false)
    expect(source.targets.map((target) => [target.key, target.hostName, target.online])).toEqual([
      ['host-a\nlocal\0bot-1', 'Mac Studio', true],
      ['host-a\nlocal\0bot-2', 'Mac Studio', true],
      ['host-b\nlocal\0bot-3', 'MacBook', false]
    ])
    expect(source.targets[0]!.client).toBe(clientA)
    expect(source.targets[2]!.client).toBe(clientB)
  })
})
