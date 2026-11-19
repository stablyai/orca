import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connectors/connector-cloud-contract'
import {
  BOT_HELLO_BUDGET_BYTES,
  connectorBots,
  placeLaunchTarget,
  type ConnectorPlacesStore
} from './connector-places'

const NO_BOTS: ConnectorPlacesStore = {}

describe('connector places', () => {
  it('decodes a bot place to the bot, for a thread or for its Chat, and nothing else', () => {
    const place = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url')
    expect(placeLaunchTarget(place(['bot', 'b1']))).toEqual({
      kind: 'bot',
      botId: 'b1'
    })
    expect(placeLaunchTarget(place(['bot-chat', 'b1']))).toEqual({
      kind: 'bot-chat',
      botId: 'b1'
    })
    expect(placeLaunchTarget(place(['bot', '']))).toBeNull()
    expect(placeLaunchTarget(place(['bot', 'b1', 'extra']))).toBeNull()
    expect(placeLaunchTarget(place(['git', 'local', 'repo-1']))).toBeNull()
    expect(placeLaunchTarget('not-a-place')).toBeNull()
  })

  it('lists bots within the contract caps, by plain Slack member ids', () => {
    const bot = (index: number): Bot => ({
      id: `b${index}`,
      name: 'n'.repeat(300),
      hostId: 'local',
      folder: `bot-${index}`,
      folderWorkspaceId: `f${index}`,
      agent: 'claude',
      avatar: null,
      paused: index === 0,
      permissionMode: 'ask',
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: [
        { id: 'U01', name: 'Ada' },
        { id: 'U02', name: 'Bea', source: 'slack' },
        // Not a Slack id, so the cloud never reads it as one.
        { id: 'D03', name: 'Cy', source: 'discord' },
        { id: 'U'.repeat(CONNECTOR_CLIENT_LIMITS.maxBotMemberIdLength + 1), name: 'Too long' },
        // JSON would write it six times longer.
        { id: '\u0001', name: 'Escaped' }
      ],
      slack: null,
      chatSessionId: null,
      linear: null,
      github: null,
      createdAt: 1,
      updatedAt: 1
    })
    const { maxHelloBots, maxBotPages } = CONNECTOR_CLIENT_LIMITS
    // Every bot a cloud's pages take, past one hello's maxHelloBots.
    const bots = Array.from({ length: maxHelloBots * maxBotPages + 1 }, (_, i) => bot(i))
    const listed = connectorBots({ getBots: () => bots })
    expect(listed).toHaveLength(maxHelloBots * maxBotPages)
    expect(listed[0]).toEqual({
      id: 'b0',
      name: 'n'.repeat(CONNECTOR_CLIENT_LIMITS.maxDisplayTextLength),
      agent: 'claude',
      members: ['U01', 'U02'],
      paused: true,
      handle: 'bot-0',
      sharedAppWorkspaces: []
    })
    expect(connectorBots(NO_BOTS)).toEqual([])
    // Bots off: still listed, all paused, so a running turn's Stop reaches this machine.
    expect(connectorBots({ getBots: () => bots.slice(0, 2) }, false).map((b) => b.paused)).toEqual([
      true,
      true
    ])
  })

  it('sends a bot on Linear with its Linear people, never in the Slack list', () => {
    const uuid = (n: number): string => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
    const bot: Bot = {
      id: 'b1',
      name: 'Reviewer',
      hostId: 'local',
      folder: 'reviewer',
      folderWorkspaceId: 'f1',
      agent: 'claude',
      avatar: null,
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: [
        { id: 'U01', name: 'Ada' },
        { id: uuid(1), name: 'Bea', source: 'linear', workspaceId: 'org-1' },
        // Allowed in another Linear workspace, so not here.
        { id: uuid(2), name: 'Cy', source: 'linear', workspaceId: 'org-2' }
      ],
      slack: null,
      linear: { workspaceId: 'org-1', workspaceName: 'Acme' },
      github: null,
      chatSessionId: null,
      createdAt: 1,
      updatedAt: 1
    }
    expect(connectorBots({ getBots: () => [bot] })).toEqual([
      {
        id: 'b1',
        name: 'Reviewer',
        agent: 'claude',
        members: ['U01'],
        paused: false,
        handle: 'reviewer',
        sharedAppWorkspaces: [{ source: 'linear', workspaceId: 'org-1', members: [uuid(1)] }]
      }
    ])

    // The cloud takes at most maxBotWorkspaceMembers people per workspace.
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `L-${i}`,
      name: `P${i}`,
      source: 'linear',
      workspaceId: 'org-1'
    }))
    const [crowded] = connectorBots({ getBots: () => [{ ...bot, members: many }] })
    expect(crowded.sharedAppWorkspaces?.[0].members).toHaveLength(
      CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers
    )
  })

  it('puts a bot on GitHub in each installation with its GitHub people, after Linear and within the cap; others in none', () => {
    const bot: Bot = {
      id: 'b1',
      name: 'Ranger',
      hostId: 'local',
      folder: 'ranger',
      folderWorkspaceId: 'f1',
      agent: 'claude',
      avatar: null,
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: [
        { id: 'U01', name: 'Ada' },
        { id: '583231', name: 'octocat', source: 'github' }
      ],
      slack: null,
      linear: { workspaceId: 'org-1', workspaceName: 'Acme' },
      github: {},
      chatSessionId: null,
      createdAt: 1,
      updatedAt: 1
    }
    const installs = Array.from(
      { length: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaces + 2 },
      (_, i) => `${100 + i}`
    )
    const [listed] = connectorBots({ getBots: () => [bot] }, true, installs)
    expect(listed.members).toEqual(['U01'])
    const [off] = connectorBots({ getBots: () => [{ ...bot, github: null }] }, true, installs)
    expect(off.sharedAppWorkspaces).toEqual([
      { source: 'linear', workspaceId: 'org-1', members: [] }
    ])
    expect(listed.sharedAppWorkspaces).toHaveLength(CONNECTOR_CLIENT_LIMITS.maxBotWorkspaces)
    expect(listed.sharedAppWorkspaces?.slice(0, 2)).toEqual([
      { source: 'linear', workspaceId: 'org-1', members: [] },
      { source: 'github', workspaceId: '100', members: ['583231'] }
    ])
  })

  it('sends Who can ask per workspace of each connector, after the rest, minus removed installations', () => {
    const uuid = (n: number): string => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
    const t1 = { appId: 'A1', teamId: 'T1' }
    const bot: Bot = {
      id: 'b1',
      name: 'Scout',
      hostId: 'local',
      folder: 'scout',
      folderWorkspaceId: 'f1',
      agent: 'claude',
      avatar: null,
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: [
        // Saved before workspaces: the bot's first Slack workspace.
        { id: 'U01', name: 'Ada' },
        { id: 'U02', name: 'Bea', source: 'slack', workspaceId: 'T2' },
        { id: uuid(1), name: 'Cy', source: 'linear', workspaceId: 'org-2' }
      ],
      slack: t1,
      slackApps: [t1, { appId: 'A2', teamId: 'T2' }],
      linear: { workspaceId: 'org-1', workspaceName: 'Acme' },
      linearWorkspaces: [
        { workspaceId: 'org-1', workspaceName: 'Acme' },
        { workspaceId: 'org-2', workspaceName: 'Beta' }
      ],
      github: { removedInstallationIds: ['101'] },
      chatSessionId: null,
      createdAt: 1,
      updatedAt: 1
    }
    const slackTeams = new Set(['slack.teams'])
    const [listed] = connectorBots({ getBots: () => [bot] }, true, ['100', '101'], slackTeams)
    // An older cloud reads only this list, for every Slack workspace.
    expect(listed.members).toEqual(['U01', 'U02'])
    expect(listed.sharedAppWorkspaces).toEqual([
      { source: 'slack', workspaceId: 'T1', members: ['U01'] },
      { source: 'slack', workspaceId: 'T2', members: ['U02'] },
      { source: 'linear', workspaceId: 'org-1', members: [] },
      { source: 'linear', workspaceId: 'org-2', members: [uuid(1)] },
      { source: 'github', workspaceId: '100', members: [] }
    ])
    // A cloud that answered without Slack rows never reads them, so it gets none.
    const [older] = connectorBots({ getBots: () => [bot] }, true, ['100'], new Set())
    expect(older.sharedAppWorkspaces?.some((row) => row.source === 'slack')).toBe(false)
  })

  it('never drops a Slack row: beside seven installations, and with sixty people in one workspace', () => {
    const { maxBotWorkspaces, maxBotWorkspaceMembers } = CONNECTOR_CLIENT_LIMITS
    const teams = [
      { appId: 'A1', teamId: 'T1' },
      { appId: 'A2', teamId: 'T2' }
    ]
    const sixty = Array.from({ length: 60 }, (_, i) => ({
      id: `U${100 + i}`,
      name: '',
      source: 'slack',
      workspaceId: 'T2'
    }))
    const bot: Bot = {
      id: 'b1',
      name: 'Scout',
      hostId: 'local',
      folder: 'scout',
      folderWorkspaceId: 'f1',
      agent: 'claude',
      avatar: null,
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: sixty,
      slack: teams[0] ?? null,
      slackApps: teams,
      linear: null,
      github: {},
      chatSessionId: null,
      createdAt: 1,
      updatedAt: 1
    }
    const installs = Array.from({ length: 7 }, (_, i) => `${100 + i}`)
    const [listed] = connectorBots(
      { getBots: () => [bot] },
      true,
      installs,
      new Set(['slack.teams'])
    )
    const rows = listed.sharedAppWorkspaces ?? []
    expect(rows.filter((row) => row.source === 'slack').map((row) => row.members.length)).toEqual([
      0, 60
    ])
    expect(rows.filter((row) => row.source === 'github')).toHaveLength(7)

    // Before the cloud answers, the hello keeps an older cloud's caps, Slack first, and says so.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [first] = connectorBots({ getBots: () => [bot] }, true, installs, null)
    const firstRows = first.sharedAppWorkspaces ?? []
    expect(firstRows).toHaveLength(maxBotWorkspaces)
    expect(firstRows.slice(0, 2).map((row) => row.workspaceId)).toEqual(['T1', 'T2'])
    expect(firstRows[1]?.members).toHaveLength(maxBotWorkspaceMembers)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('keeps every bot at its caps on GitHub within its share of a hello, dropping installations last-first', () => {
    const { maxHelloBots, maxBotWorkspaceMembers, maxBotWorkspaces, maxRequestBytes } =
      CONNECTOR_CLIENT_LIMITS
    const largest = (index: number): Bot => ({
      id: String(index).padStart(CONNECTOR_CLIENT_LIMITS.maxBotIdLength, 'b'),
      name: '\u0001'.repeat(CONNECTOR_CLIENT_LIMITS.maxDisplayTextLength),
      hostId: 'local',
      folder: 'h'.repeat(CONNECTOR_CLIENT_LIMITS.maxBotHandleLength),
      folderWorkspaceId: 'f1',
      agent: 'claude',
      avatar: null,
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: [
        ...Array.from({ length: 100 }, (_, i) => ({
          id: `U${String(i).padStart(31, '0')}`,
          name: ''
        })),
        ...Array.from({ length: maxBotWorkspaceMembers }, (_, i) => ({
          id: `L${String(i).padStart(63, '0')}`,
          name: '',
          source: 'linear',
          workspaceId: 'w'.repeat(CONNECTOR_CLIENT_LIMITS.maxBotIdLength)
        })),
        ...Array.from({ length: maxBotWorkspaceMembers }, (_, i) => ({
          id: String(i + 1).padStart(20, '9'),
          name: '',
          source: 'github'
        })),
        // Not a GitHub id: never sent.
        { id: 'not-a-number', name: '', source: 'github' }
      ],
      slack: null,
      linear: {
        workspaceId: 'w'.repeat(CONNECTOR_CLIENT_LIMITS.maxBotIdLength),
        workspaceName: 'A'
      },
      github: {},
      chatSessionId: null,
      createdAt: 1,
      updatedAt: 1
    })
    const installs = [
      ...Array.from({ length: maxBotWorkspaces }, (_, i) => String(i + 1).padStart(20, '9')),
      'not-a-number'
    ]
    const bots = connectorBots(
      { getBots: () => Array.from({ length: maxHelloBots }, (_, i) => largest(i)) },
      true,
      installs
    )
    for (const bot of bots) {
      expect(Buffer.byteLength(JSON.stringify(bot))).toBeLessThanOrEqual(BOT_HELLO_BUDGET_BYTES)
      const gitHub = bot.sharedAppWorkspaces?.filter((workspace) => workspace.source === 'github')
      expect(gitHub?.[0].members).toHaveLength(maxBotWorkspaceMembers)
      expect(gitHub?.every((workspace) => /^\d+$/.test(workspace.workspaceId))).toBe(true)
    }
    expect(Buffer.byteLength(JSON.stringify(bots))).toBeLessThan(maxRequestBytes - 8 * 1024)

    // Slack rows at their caps too, with room left by fewer installations.
    const teams = Array.from({ length: maxBotWorkspaces }, (_, i) => ({
      appId: `A${i}`,
      teamId: `T${String(i).padStart(CONNECTOR_CLIENT_LIMITS.maxBotIdLength - 1, '0')}`
    }))
    const inSlack = (index: number): Bot => {
      const bot = largest(index)
      return {
        ...bot,
        slack: teams[0] ?? null,
        slackApps: teams,
        members: [
          ...bot.members.filter((member) => member.source !== undefined),
          ...teams.flatMap((team) =>
            Array.from({ length: maxBotWorkspaceMembers }, (_, i) => ({
              id: `U${String(i).padStart(CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMemberIdLength - 1, '0')}`,
              name: '',
              source: 'slack',
              workspaceId: team.teamId
            }))
          )
        ]
      }
    }
    const slackBots = connectorBots(
      { getBots: () => Array.from({ length: maxHelloBots }, (_, i) => inSlack(i)) },
      true,
      installs.slice(0, 1)
    )
    for (const bot of slackBots) {
      expect(Buffer.byteLength(JSON.stringify(bot))).toBeLessThanOrEqual(BOT_HELLO_BUDGET_BYTES)
      expect(bot.sharedAppWorkspaces?.some((workspace) => workspace.source === 'slack')).toBe(true)
    }
  })
})
