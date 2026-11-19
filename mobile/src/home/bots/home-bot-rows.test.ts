import { describe, expect, it } from 'vitest'
import { normalizeBotSidebarView } from '../../../../src/shared/bots/bot-sidebar-view'
import type { BotComputerAnswer } from '../../bots/bot-link-host-reads'
import type { KeptComputerAnswer } from '../../bots/kept-computer-bots'
import type { HomeComputerBots } from './home-bots-query'
import type { PhoneBot } from '../../bots/host-bots-operations'
import { botHomeWorktreeId } from '../../bots/host-bots-read'
import { pairedNewBotComputers } from '../../bots/new-bot-computers'
import type { HostWorktreeInfo } from '../../worktree/catalog/home-worktree-info'
import { homeBotRows, homeNewBotComputers, type HomeBotRowsInput } from './home-bot-rows'

const NOW = 1_800_000_000_000

function bot(id: string, name: string, extra: Partial<PhoneBot> = {}): PhoneBot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only a bot's id, name, home, avatar, paused and chat.
  return {
    id,
    name,
    folderWorkspaceId: `home-${id}`,
    avatar: 'mascot:A1',
    paused: false,
    agent: 'claude',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    ...extra
  } as PhoneBot
}

function listed(
  key: string,
  bots: PhoneBot[],
  extra: Partial<Extract<BotComputerAnswer['answer'], { kind: 'bots' }>> = {}
): BotComputerAnswer['answer'] {
  return {
    kind: 'bots',
    bots,
    hideBotCreated: false,
    view: normalizeBotSidebarView(undefined),
    enabled: true,
    takesCreate: true,
    takesTemplates: true,
    waits: {},
    needsYou: {},
    ...extra
  }
}

function computer(
  pairedHostId: string,
  executionHost: BotComputerAnswer['executionHost'],
  answer: BotComputerAnswer['answer'],
  extra: Partial<KeptComputerAnswer> = {}
): KeptComputerAnswer {
  return {
    key: `${pairedHostId}\n${executionHost}`,
    pairedHostId,
    executionHost,
    answer,
    readAt: NOW,
    ...extra
  }
}

function agentOn(worktreeId: string, state: string, updatedAt: number) {
  return {
    worktreeId,
    workspaceName: 'home',
    repo: 'home',
    branch: '',
    agent: { paneKey: `${worktreeId}:1`, state, updatedAt, startedAt: updatedAt - 1000 }
  }
}

const on = (...answers: BotComputerAnswer[]): HomeComputerBots => ({
  answers,
  groups: [],
  epoch: 'e1',
  readAt: NOW
})

function input(overrides: Partial<HomeBotRowsInput>): HomeBotRowsInput {
  return {
    hosts: [
      { id: 'studio', name: 'Studio Mac' },
      { id: 'air', name: 'MacBook Air' }
    ],
    hostStates: { studio: 'connected', air: 'connected' },
    botsByHost: {},
    freshHosts: new Set(['studio', 'air']),
    kept: {},
    hydrated: new Set(['studio', 'air', 'box']),
    worktreeInfo: {},
    now: NOW,
    ...overrides
  }
}

describe('Home bots', () => {
  it('lists every computer’s bots needs-you first, then the most recent, and counts Needs you', () => {
    const result = homeBotRows(
      input({
        botsByHost: {
          studio: on(
            computer(
              'studio',
              'local',
              listed('studio', [bot('builder', 'Bot builder'), bot('ux', 'ux-designer')], {
                needsYou: { builder: 2 }
              })
            )
          ),
          air: on(computer('air', 'local', listed('air', [bot('atlas', 'Atlas')])))
        },
        worktreeInfo: {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only an agent's paneKey, state and times.
          air: {
            hostId: 'air',
            totalWorktrees: 1,
            activeCount: 1,
            agents: [agentOn(botHomeWorktreeId(bot('atlas', 'Atlas')), 'working', NOW - 60_000)]
          } as unknown as HostWorktreeInfo
        }
      })
    )
    expect(result.rows.map((row) => [row.title, row.hostLabel, row.needsYou, row.dot])).toEqual([
      ['Bot builder', 'Studio Mac', 2, 'inactive'],
      ['Atlas', 'MacBook Air', 0, 'working'],
      ['ux-designer', 'Studio Mac', 0, 'inactive']
    ])
    expect(result.needsYou).toBe(2)
  })

  it('lists a server two computers relay once, under its own name', () => {
    const server = (paired: string) =>
      computer(paired, 'runtime:build-box', listed(paired, [bot('ci', 'Nightly CI')]), {
        serverLabel: 'build-box',
        installationId: 'install-build-box'
      })
    const result = homeBotRows(
      input({
        botsByHost: {
          studio: on(computer('studio', 'local', listed('studio', [])), server('studio')),
          air: on(computer('air', 'local', listed('air', [])), server('air'))
        }
      })
    )
    expect(result.rows.map((row) => [row.title, row.hostLabel, row.pairedHostId])).toEqual([
      ['Nightly CI', 'build-box', 'studio']
    ])
  })

  it('lists a relayed server through the computer that reaches it, under the same key', () => {
    const server = (paired: string, answer: BotComputerAnswer['answer']) =>
      computer(paired, 'runtime:build-box', answer, {
        serverLabel: 'build-box',
        installationId: 'install-build-box'
      })
    const reachable = server('air', listed('air', [bot('ci', 'Nightly CI')]))
    const viaAir = homeBotRows(
      input({
        botsByHost: {
          studio: on(server('studio', { kind: 'unreachable' })),
          air: on(reachable)
        }
      })
    ).rows
    const viaStudio = homeBotRows(
      input({ botsByHost: { studio: on(server('studio', reachable.answer)) } })
    ).rows
    expect(viaAir.map((row) => [row.title, row.pairedHostId])).toEqual([['Nightly CI', 'air']])
    expect(viaAir[0]?.key).toBe(viaStudio[0]?.key)
  })

  it('lists the computer’s group rooms among its bots, unread as their home is', () => {
    const ROOM = {
      id: 'g1',
      folderWorkspaceId: 'room-home',
      name: 'Release room',
      members: [{ botId: 'atlas', sessionId: 's1' }],
      latest: { text: 'Shipped', at: NOW - 120_000, authorName: 'Atlas' }
    }
    const result = homeBotRows(
      input({
        botsByHost: {
          studio: {
            answers: [computer('studio', 'local', listed('studio', [bot('atlas', 'Atlas')]))],
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only a room's id, name, members and latest post.
            groups: [ROOM as never],
            epoch: 'e1',
            readAt: NOW
          }
        },
        worktreeInfo: {
          studio: {
            hostId: 'studio',
            totalWorktrees: 0,
            activeCount: 0,
            agents: [],
            unreadWorktreeIds: [botHomeWorktreeId(ROOM)]
          }
        }
      })
    )
    expect(result.rows.map((row) => [row.kind, row.title, row.preview, row.unread])).toEqual([
      ['group', 'Release room', 'Atlas: Shipped', true],
      ['bot', 'Atlas', '', false]
    ])
  })

  it('dims an offline computer’s kept bots in place, with no Needs you and how long ago', () => {
    const atlas = bot('atlas', 'Atlas')
    const result = homeBotRows(
      input({
        hostStates: { studio: 'connected', air: 'disconnected' },
        botsByHost: { studio: on(computer('studio', 'local', listed('studio', []))) },
        kept: {
          air: {
            answers: [computer('air', 'local', listed('air', [atlas], { needsYou: { atlas: 1 } }))],
            groups: [],
            lastActivity: { 'air\nlocal\nbot:atlas': NOW - 30 * 60_000 }
          }
        }
      })
    )
    expect(
      result.rows.map((row) => [row.title, row.offline, row.needsYou, row.age, row.dot])
    ).toEqual([['Atlas', true, 0, '30m', null]])
    expect(result.needsYou).toBe(0)
  })

  it('keeps a reconnecting computer’s bots as they were, counting no Needs you until it answers', () => {
    const atlas = bot('atlas', 'Atlas')
    const last = computer('air', 'local', listed('air', [atlas], { needsYou: { atlas: 2 } }))
    const result = homeBotRows(
      input({
        hostStates: { studio: 'connected', air: 'connected' },
        botsByHost: { air: on(last) },
        freshHosts: new Set(['studio']),
        kept: { air: { answers: [last], groups: [], lastActivity: {} } }
      })
    )
    expect(result.rows.map((row) => [row.title, row.offline, row.needsYou])).toEqual([
      ['Atlas', undefined, 0]
    ])
    expect(result.needsYou).toBe(0)
  })

  it('keeps a down server’s last listing dimmed while its computer is live, and a failed read never replaces it', () => {
    const ci = bot('ci', 'Nightly CI')
    const kept = {
      answers: [
        computer('studio', 'runtime:build-box', listed('studio', [ci]), {
          serverLabel: 'build-box'
        }),
        computer('studio', 'runtime:mini', listed('studio', [bot('m', 'Mini bot')]), {
          serverLabel: 'mini'
        })
      ],
      groups: [],
      lastActivity: {}
    }
    const result = homeBotRows(
      input({
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [])),
            computer(
              'studio',
              'runtime:build-box',
              { kind: 'unreachable' },
              { serverLabel: 'build-box' }
            ),
            computer('studio', 'runtime:mini', { kind: 'unreadable' }, { serverLabel: 'mini' })
          )
        },
        kept: { studio: kept }
      })
    )
    expect(result.rows.map((row) => [row.title, row.offline])).toEqual([
      ['Mini bot', undefined],
      ['Nightly CI', true]
    ])
  })

  it('says why each computer lists no bots, and a paired computer’s switch hides its servers', () => {
    const result = homeBotRows(
      input({
        hostStates: { studio: 'connected', air: 'connected', box: 'disconnected' },
        hosts: [
          { id: 'studio', name: 'Studio Mac' },
          { id: 'air', name: 'MacBook Air' },
          { id: 'box', name: 'Linux box' }
        ],
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [], { enabled: false })),
            computer('studio', 'runtime:build-box', listed('studio', [bot('ci', 'Nightly CI')]), {
              serverLabel: 'build-box'
            })
          ),
          air: on(computer('air', 'local', { kind: 'no-capability' }))
        }
      })
    )
    expect(result.rows).toEqual([])
    expect(result.listable).toBe(false)
    expect(result.unavailable.map((entry) => [entry.label, entry.reason])).toEqual([
      ['Linux box', 'unreachable'],
      ['Studio Mac', 'off'],
      ['MacBook Air', 'update']
    ])
  })

  it('keeps every server it listed when the relay inventory fails, and their rooms when theirs does', () => {
    const ci = bot('ci', 'Nightly CI')
    const kept = {
      answers: [
        computer('studio', 'local', listed('studio', [])),
        computer('studio', 'runtime:build-box', listed('studio', [ci]), {
          serverLabel: 'build-box'
        })
      ],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only a room's id, name, members and home.
      groups: [{ id: 'g1', name: 'Room', members: [], folderWorkspaceId: 'r' } as never],
      lastActivity: {}
    }
    const read: HomeComputerBots = {
      ...on(computer('studio', 'local', listed('studio', [])), {
        ...computer('studio', 'local', { kind: 'unreadable' }),
        key: 'studio\nrelay-inventory'
      }),
      groups: null
    }
    const result = homeBotRows(input({ botsByHost: { studio: read }, kept: { studio: kept } }))
    expect(result.rows.map((row) => [row.kind, row.title])).toEqual([
      ['bot', 'Nightly CI'],
      ['group', 'Room']
    ])
  })

  it('reaches a server through the computer that read it on this connection, not a kept route', () => {
    const ci = bot('ci', 'Nightly CI')
    const server = (paired: string, needsYou: number) =>
      computer(paired, 'runtime:build-box', listed(paired, [ci], { needsYou: { ci: needsYou } }), {
        serverLabel: 'build-box',
        installationId: 'install-build-box'
      })
    const result = homeBotRows(
      input({
        hostStates: { studio: 'disconnected', air: 'connected' },
        botsByHost: { air: on(computer('air', 'local', listed('air', [])), server('air', 2)) },
        freshHosts: new Set(['air']),
        kept: {
          studio: {
            answers: [computer('studio', 'local', listed('studio', [])), server('studio', 0)],
            groups: [],
            lastActivity: {}
          }
        }
      })
    )
    expect(result.rows.map((row) => [row.title, row.pairedHostId, row.offline])).toEqual([
      ['Nightly CI', 'air', undefined]
    ])
    expect(result.needsYou).toBe(2)
  })

  it('offers no server behind a computer whose Bots switch is off', () => {
    const result = homeBotRows(
      input({
        hosts: [{ id: 'studio', name: 'Studio Mac' }],
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [], { enabled: false })),
            computer('studio', 'runtime:build-box', listed('studio', [bot('ci', 'CI')]), {
              serverLabel: 'build-box'
            })
          )
        }
      })
    )
    const offered = pairedNewBotComputers(
      result.computers,
      (entry) => result.labels.get(entry.key) ?? ''
    )
    expect(offered.map((entry) => [entry.label, entry.refusal])).toEqual([
      ['Studio Mac', 'Bots are off on Studio Mac']
    ])
  })

  it('leaves out a computer that isn’t connected', () => {
    const result = homeBotRows(
      input({
        hostStates: { studio: 'connected', air: 'disconnected' },
        botsByHost: {
          air: on(
            computer(
              'air',
              'local',
              listed('air', [bot('atlas', 'Atlas')], { needsYou: { atlas: 1 } })
            )
          )
        }
      })
    )
    expect(result.rows).toEqual([])
    expect(result.needsYou).toBe(0)
  })
})

describe('Home bots while a computer is down or still loading', () => {
  const ci = bot('ci', 'Nightly CI')
  const server = (paired: string, extra: Partial<KeptComputerAnswer> = {}) =>
    computer(paired, 'runtime:build-box', listed(paired, [ci]), {
      serverLabel: 'build-box',
      installationId: 'install-build-box',
      ...extra
    })
  const runsOn = (result: ReturnType<typeof homeBotRows>) =>
    homeNewBotComputers(result).map((entry) => [entry.label, entry.refusal])

  it('lists a server through an enabled computer when another that relays it has Bots off', () => {
    const result = homeBotRows(
      input({
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [], { enabled: false })),
            server('studio')
          ),
          air: on(computer('air', 'local', listed('air', [])), server('air'))
        }
      })
    )
    expect(result.rows.map((row) => [row.title, row.pairedHostId])).toEqual([['Nightly CI', 'air']])
  })

  it('keeps a computer’s bots, rooms and servers when its own read and status fail', () => {
    const kept = {
      answers: [
        computer('studio', 'local', listed('studio', [bot('atlas', 'Atlas')])),
        server('studio')
      ],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only a room's id, name, members and home.
      groups: [{ id: 'g1', name: 'Room', members: [], folderWorkspaceId: 'r' } as never],
      lastActivity: {}
    }
    const read: HomeComputerBots = {
      ...on(computer('studio', 'local', { kind: 'unreadable' }), {
        ...computer('studio', 'local', { kind: 'unreadable' }),
        key: 'studio\nrelay-inventory'
      }),
      groups: null
    }
    const result = homeBotRows(
      input({
        hosts: [{ id: 'studio', name: 'Studio Mac' }],
        botsByHost: { studio: read },
        kept: { studio: kept }
      })
    )
    expect(result.rows.map((row) => row.title).sort()).toEqual(['Atlas', 'Nightly CI', 'Room'])
  })

  it('waits for a computer’s kept copy before saying anything about a failed answer', () => {
    const result = homeBotRows(
      input({
        hosts: [{ id: 'studio', name: 'Studio Mac' }],
        hydrated: new Set(),
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [])),
            computer(
              'studio',
              'runtime:build-box',
              { kind: 'unreachable' },
              { serverLabel: 'build-box' }
            )
          )
        }
      })
    )
    expect(result.awaiting).toBe(true)
    expect(result.unavailable).toEqual([])
  })

  it('lists Runs on placeholders for offline, connecting, and unreadable computers', () => {
    const hosts = [
      { id: 'studio', name: 'Studio Mac' },
      { id: 'air', name: 'MacBook Air' },
      { id: 'mini', name: 'Mac mini' },
      { id: 'laptop', name: 'Laptop' },
      { id: 'box', name: 'Build box' }
    ]
    const result = homeBotRows(
      input({
        hosts,
        hostStates: {
          studio: 'connected',
          air: 'disconnected',
          mini: 'connecting',
          laptop: 'connected',
          box: 'disconnected'
        },
        freshHosts: new Set(['studio', 'laptop']),
        hydrated: new Set(['studio', 'air', 'mini', 'box']),
        botsByHost: {
          studio: on(computer('studio', 'local', listed('studio', []))),
          laptop: on(computer('laptop', 'local', { kind: 'unreadable' }))
        },
        kept: { box: { answers: [], groups: [], lastActivity: {} } }
      })
    )
    expect(runsOn(result)).toEqual([
      ['Studio Mac', undefined],
      ['MacBook Air', 'Offline'],
      ['Mac mini', 'Checking…'],
      ['Laptop', 'Checking…'],
      ['Build box', 'Offline']
    ])
    expect(result.unavailable.map((entry) => [entry.label, entry.reason])).toEqual([
      ['MacBook Air', 'unreachable'],
      ['Build box', 'unreachable']
    ])
  })

  it('keeps an offline server bot’s last activity when its computer answers without it', () => {
    const kept = {
      answers: [computer('studio', 'local', listed('studio', [])), server('studio')],
      groups: [],
      lastActivity: {}
    }
    const solo = { hosts: [{ id: 'studio', name: 'Studio Mac' }] }
    const ciKey = homeBotRows(input({ ...solo, kept: { studio: kept } })).rows[0]?.key ?? ''
    const result = homeBotRows(
      input({
        ...solo,
        kept: { studio: { ...kept, lastActivity: { [ciKey]: 123 } } },
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [])),
            server('studio', { answer: { kind: 'unreachable' } })
          )
        }
      })
    )
    expect(result.rows.map((row) => [row.title, row.activityAt])).toEqual([['Nightly CI', 123]])
    expect(result.activityByHost.get('studio')).toEqual({ [ciKey]: 123 })
  })
})

describe('New bot from Home', () => {
  it('makes a server two computers relay through the one that passes New bot on', () => {
    const server = (paired: string) =>
      computer(paired, 'runtime:build-box', listed(paired, [bot('ci', 'Nightly CI')]), {
        serverLabel: 'build-box',
        installationId: 'install-build-box'
      })
    const result = homeBotRows(
      input({
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [], { takesCreate: false })),
            server('studio')
          ),
          air: on(computer('air', 'local', listed('air', [])), server('air'))
        }
      })
    )
    const buildBox = pairedNewBotComputers(
      result.computers,
      (entry) => result.labels.get(entry.key) ?? ''
    ).find((entry) => entry.label === 'build-box')
    expect(buildBox).toMatchObject({ id: 'air\nruntime:build-box' })
    expect(buildBox?.refusal).toBeUndefined()
  })

  it('offers each computer and its servers, with why one can’t take a bot', () => {
    const result = homeBotRows(
      input({
        botsByHost: {
          studio: on(
            computer('studio', 'local', listed('studio', [])),
            computer('studio', 'runtime:build-box', listed('studio', [], { enabled: false }), {
              serverLabel: 'build-box'
            }),
            computer(
              'studio',
              'runtime:ci-mini',
              { kind: 'unreachable' },
              { serverLabel: 'ci-mini' }
            )
          ),
          air: on(computer('air', 'local', { kind: 'no-capability' }))
        }
      })
    )
    const computers = pairedNewBotComputers(
      result.computers,
      (entry) => result.labels.get(entry.key) ?? ''
    )
    expect(computers.map((entry) => [entry.label, entry.refusal])).toEqual([
      ['Studio Mac', undefined],
      ['build-box', 'Bots are off on build-box'],
      ['ci-mini', 'Offline'],
      ['MacBook Air', 'Update Orca on MacBook Air']
    ])
  })
})
