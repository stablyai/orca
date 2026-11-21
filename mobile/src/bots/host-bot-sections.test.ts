import { describe, expect, it } from 'vitest'
import type {
  CrossStoreWorkspaceLineage,
  WorkspaceLineage
} from '../../../src/shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import { structuredAgentSessionStatusPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-tab'
import { buildHostBotSections, isProjectListRow, type HostBotListing } from './host-bot-sections'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../../../src/shared/bots/bot-sidebar-view'
import { hostBotTreeKey } from './bot-chat-tree-reads'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { mobileBotRowLine, mobileBotRowLineText } from './mobile-bot-row-line'

function row(worktreeId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId: 'local',
    repo: 'acme-web',
    branch: worktreeId,
    displayName: worktreeId,
    path: `/repo/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

const home = row('folder:atlas-home', {
  workspaceKind: 'folder-workspace',
  repoId: 'folder-workspace:bots-group',
  repo: 'Bots',
  displayName: 'atlas',
  path: '/Users/me/.orca/bots/atlas'
})
const worker = row('wt-flaky', {
  displayName: 'fix-flaky-login-test',
  status: 'working'
})
const plain = row('wt-main', { displayName: 'main' })

const workerLink: WorkspaceLineage = {
  childWorkspaceKey: 'worktree:wt-flaky',
  parentWorkspaceKey: 'folder:atlas-home',
  origin: 'orchestration',
  capture: { source: 'orchestration-context', confidence: 'explicit' },
  createdAt: 1
}

function listing(overrides: Partial<Extract<HostBotListing, { kind: 'listed' }>> = {}) {
  return {
    kind: 'listed' as const,
    hostId: 'local' as const,
    hostLabel: 'MacBook',
    bots: [
      {
        id: 'bot-1',
        name: 'Atlas',
        folderWorkspaceId: 'atlas-home',
        avatar: 'mascot:A1',
        paused: false,
        chatSessionId: null
      }
    ],
    hideBotCreated: true,
    view: DEFAULT_BOT_SIDEBAR_VIEW,
    workspaceLineage: { 'worktree:wt-flaky': workerLink },
    worktreeLineage: {},
    avatarUris: new Map(),
    ...overrides
  }
}

function build(
  listings: HostBotListing[],
  extra: Partial<Parameters<typeof buildHostBotSections>[0]> = {}
) {
  return buildHostBotSections({
    rows: [home, worker, plain],
    listings,
    collapsedGroups: new Set(),
    repoHostIdByRepoId: new Map(),
    search: '',
    drawRow: (row) => ({ row, view: {} }),
    pairedHostId: 'paired',
    chatTrees: new Map(),
    chatFolds: {},
    chatSteps: {},
    ...extra
  })
}

function workingRow(paneKey: string): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: 'the ask',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 0,
    updatedAt: 0
  }
}

// What the project list keeps once the Bots sections take their rows.
function projectRows(built: ReturnType<typeof build>, rows = [home, worker, plain]) {
  return rows
    .filter((item) => isProjectListRow(item, built.listedIdentities, new Map()))
    .map((item) => item.worktreeId)
}

describe('buildHostBotSections', () => {
  it("lists bots by the host's Bot options, still leaving hidden rows out of the projects", () => {
    const sleeping = row('wt-old', { displayName: 'old-sweep', status: 'inactive' })
    const rows = [home, worker, sleeping, plain]
    const lineage = {
      'worktree:wt-flaky': workerLink,
      'worktree:wt-old': { ...workerLink, childWorkspaceKey: 'worktree:wt-old' as const }
    }
    const sleepingHidden = build(
      [
        listing({
          workspaceLineage: lineage,
          view: { ...DEFAULT_BOT_SIDEBAR_VIEW, hideSleepingWorkers: true }
        })
      ],
      { rows }
    )
    expect(sleepingHidden.sections[0]?.data.map((item) => item.row.displayName)).toEqual([
      'Atlas',
      'fix-flaky-login-test'
    ])
    expect(projectRows(sleepingHidden, rows)).toEqual(['wt-main'])

    const pausedHidden = build([
      listing({
        bots: [
          {
            id: 'bot-1',
            name: 'Atlas',
            folderWorkspaceId: 'atlas-home',
            avatar: null,
            paused: true,
            chatSessionId: null
          }
        ],
        view: { ...DEFAULT_BOT_SIDEBAR_VIEW, hidePausedBots: true }
      })
    ])
    expect(pausedHidden.sections[0]?.data).toEqual([])
    expect(pausedHidden.sections[0]?.count).toBe(0)
    expect(projectRows(pausedHidden)).toEqual(['wt-main'])
  })

  it('lists every workspace under its home on another machine, however it got there, with its children', () => {
    const remote = (worktreeId: string, origin: 'orchestration' | 'cli' | null): Worktree =>
      row(worktreeId, {
        hostId: 'runtime:windows-2',
        repoId: 'win-repo',
        worktreeInstanceId: `instance-${worktreeId}`,
        ...(origin
          ? {
              crossStoreParent: {
                childWorkspaceKey: `worktree:${worktreeId}`,
                childInstanceId: `instance-${worktreeId}`,
                parent: {
                  installationId: 'this-mac',
                  workspaceKey: 'folder:atlas-home',
                  instanceId: 'atlas-home'
                },
                origin,
                capture: { source: 'orchestration-context', confidence: 'explicit' },
                createdAt: 1
              }
            }
          : {})
      })
    const remoteWorker = remote('win-worker', 'orchestration')
    const remoteChild = row('win-child', {
      hostId: 'runtime:windows-2',
      repoId: 'win-repo',
      worktreeInstanceId: 'instance-win-child',
      parentWorktreeId: 'win-worker',
      lineageWorktreeInstanceId: 'instance-win-child',
      parentWorktreeInstanceId: 'instance-win-worker'
    })
    const byHand = remote('win-by-hand', 'cli')
    const rows = [home, worker, plain, remoteWorker, remoteChild, byHand]
    const built = build([listing()], {
      rows,
      lineageStores: {
        ownInstallationId: 'this-mac',
        servers: [{ hostId: 'runtime:windows-2', installationId: 'windows-2-install' }]
      }
    })

    expect(
      built.sections[0]?.data.map((item) => [item.row.worktreeId, item.view.projectGroupDepth])
    ).toEqual([
      ['folder:atlas-home', 0],
      ['wt-flaky', 1],
      ['win-by-hand', 1],
      ['win-worker', 1],
      ['win-child', 2]
    ])
    expect(projectRows(built, rows)).toEqual(['wt-main'])
  })

  it('keeps the open worker line when Hide sleeping workers hides the quiet ones', () => {
    const open = row('wt-flaky', { displayName: 'fix-flaky-login-test', status: 'inactive' })
    const built = build(
      [listing({ view: { ...DEFAULT_BOT_SIDEBAR_VIEW, hideSleepingWorkers: true } })],
      {
        rows: [home, open, plain],
        // This phone's highlight picks the line, as the host's isActive would.
        drawRow: (item) => ({
          row: { ...item, isActive: item.worktreeId === 'wt-flaky' },
          view: {}
        })
      }
    )
    expect(built.sections[0]?.data.map((item) => item.row.worktreeId)).toEqual([
      'folder:atlas-home',
      'wt-flaky'
    ])
  })

  it('leads with the bot and its worker workspace, and lists both for the project list to leave out', () => {
    const built = build([listing()])
    const [bots] = built.sections
    expect(built.sections).toHaveLength(1)
    expect(bots?.title).toBe('Bots')
    expect(bots?.data.map((item) => item.row.displayName)).toEqual([
      'Atlas',
      'fix-flaky-login-test'
    ])
    expect(bots?.data[0]?.view.botFacts).toMatchObject({
      avatar: { kind: 'mascot', id: 'A1' },
      status: 'working',
      // The row's own dot is its own turn; its working workspace shows on the fold instead.
      dot: 'active',
      foldLive: 'working',
      statusLine: 'Idle'
    })
    expect(bots?.data[0]?.view.lineageChildCount).toBe(1)
    expect(bots?.data[1]?.view.projectGroupDepth).toBe(1)
    expect(projectRows(built)).toEqual(['wt-main'])
  })

  it('lists a group among its bots in their one saved order, and leaves its home out of the projects', () => {
    const groupHome = row('folder:review-home', {
      workspaceKind: 'folder-workspace',
      repoId: 'folder-workspace:bots-group',
      path: '/Users/me/.orca/bots/group-review',
      unread: true,
      // A member's session in the room, waiting on its owner.
      agents: [
        {
          paneKey: structuredAgentSessionStatusPaneKey('member-1'),
          parentPaneKey: null,
          state: 'blocked',
          agentType: 'claude',
          prompt: '',
          taskTitle: null,
          displayName: null,
          lastAssistantMessage: null,
          toolName: null,
          toolInput: null,
          interrupted: false,
          stateStartedAt: 0,
          updatedAt: 0
        }
      ]
    })
    const rows = [home, groupHome, worker, plain]
    const group = {
      id: 'group-1',
      name: 'Review crew',
      hostId: 'local' as const,
      revision: 1,
      folder: 'group-review',
      folderWorkspaceId: 'review-home',
      createdAt: 1,
      members: [{ botId: 'bot-1', sessionId: 'member-1' }],
      replyMode: { kind: 'all' as const },
      sidebarOrder: 0,
      latest: { authorName: null, text: 'ship it', at: 5 }
    }
    // A drag placed the group first; the host sends each one's place beside its record.
    const atlas = { ...listing().bots[0]!, sidebarOrder: 1 }
    const built = build([listing({ bots: [atlas], groups: [group] })], { rows })
    const [bots] = built.sections
    expect(bots?.count).toBe(2)
    expect(bots?.data.map((item) => item.row.displayName)).toEqual([
      'Review crew',
      'Atlas',
      'fix-flaky-login-test'
    ])
    expect(bots?.data[0]?.row.unread).toBe(true)
    expect(bots?.data[0]?.view.botGroupFacts).toMatchObject({
      group: { id: 'group-1' },
      members: [{ id: 'bot-1', name: 'Atlas' }],
      dot: 'permission'
    })
    // The folded header's faces are bots only, as on the desktop.
    expect(bots?.botPreview?.map((bot) => bot.name)).toEqual(['Atlas'])
    expect(projectRows(built, rows)).toEqual(['wt-main'])
  })

  it('keeps a relayed server’s group homes out of its projects without listing their rooms', () => {
    const remote = 'runtime:box' as const
    const groupHome = row('folder:review-home', {
      workspaceKind: 'folder-workspace',
      hostId: remote,
      repoId: 'folder-workspace:bots-group'
    })
    const built = build(
      [
        listing({
          hostId: remote,
          bots: [],
          groups: [
            {
              id: 'group-1',
              name: 'Review crew',
              hostId: 'local',
              revision: 1,
              folder: 'group-review',
              folderWorkspaceId: 'review-home',
              createdAt: 1,
              members: [],
              replyMode: { kind: 'all' }
            }
          ]
        })
      ],
      { rows: [groupHome] }
    )
    expect(built.sections[0]?.data).toEqual([])
    expect(built.listedIdentities.size).toBe(1)
  })

  it('counts the whole roster for New group while a search hides some bots', () => {
    const nova = {
      ...listing().bots[0]!,
      id: 'bot-2',
      name: 'Nova',
      folderWorkspaceId: 'nova-home'
    }
    const novaHome = row('folder:nova-home', {
      workspaceKind: 'folder-workspace',
      repoId: 'folder-workspace:bots-group',
      path: '/Users/me/.orca/bots/nova'
    })
    const rows = [home, novaHome, worker, plain]
    for (const search of ['Atlas', 'no match']) {
      const [bots] = build([listing({ bots: [listing().bots[0]!, nova] })], {
        rows,
        search
      }).sections
      expect(bots?.botCount).toBe(2)
    }
  })

  it('folds the bot section and a bot by the keys the desktop folds them by', () => {
    const folded = build([listing()], {
      collapsedGroups: new Set(['lineage:folder:atlas-home'])
    }).sections[0]
    expect(folded?.data.map((item) => item.row.displayName)).toEqual(['Atlas'])
    const hidden = build([listing()], { collapsedGroups: new Set(['bots']) }).sections[0]
    expect(hidden).toMatchObject({ key: 'bots', count: 1, data: [] })
  })

  it('says what a folded bot’s side chat is doing, from its host’s own-chat list', () => {
    const paneKey = 'structured-agent-session:side-1'
    const folded = build(
      [listing({ ownChats: { 'bot-1': [{ paneKey, title: 'Plan the launch' }] } })],
      {
        collapsedGroups: new Set(['lineage:folder:atlas-home'])
      }
    ).sections[0]
    const facts = folded?.data[0]?.view.botFacts
    const line = facts ? mobileBotRowLine(facts, [workingRow(paneKey)], 0) : null
    expect(line ? mobileBotRowLineText(line, 0) : null).toBe('Replying in Plan the launch')
  })

  it('keeps collapsed preview facts host-scoped, and counts Up next apart from unread', () => {
    const remote = 'runtime:box' as const
    const remoteHome = { ...home, hostId: remote }
    const local = listing({ unseen: { 'bot-1': 7 } })
    const server = listing({
      hostId: remote,
      hostLabel: 'box',
      workspaceLineage: {},
      bots: [{ ...local.bots[0]!, name: 'Server Atlas', paused: true }]
    })
    const sections = build([local, server], {
      rows: [home, worker, remoteHome],
      collapsedGroups: new Set(['bots'])
    }).sections
    expect(sections).toHaveLength(1)
    expect(sections[0]?.data).toEqual([])
    // New Up next suggestions aren't messages: the row counts them, the header's unread does not.
    // The same bot id on two computers is two faces.
    expect(sections[0]?.botPreview).toMatchObject([
      { id: 'local|bot-1', name: 'Atlas', unread: false, status: 'working' },
      { id: 'runtime:box|bot-1', name: 'Server Atlas', unread: false, paused: true }
    ])
    const expanded = build([local], { rows: [home, worker] }).sections[0]
    expect(expanded?.data[0]?.view.botFacts).toMatchObject({ upNext: 7 })
  })

  it('lists every computer’s bots in one section: this computer’s first, server bots with their pill', () => {
    const remote = 'runtime:box' as const
    const remoteHome = { ...home, hostId: remote, path: '/home/me/.orca/bots/atlas' }
    const server = listing({
      hostId: remote,
      hostLabel: 'box',
      workspaceLineage: {},
      bots: [{ ...listing().bots[0]!, name: 'Server Atlas' }]
    })
    const [bots, ...rest] = build([listing(), server], {
      rows: [home, worker, plain, remoteHome]
    }).sections
    expect(rest).toEqual([])
    expect(bots).toMatchObject({ key: 'bots', title: 'Bots', count: 2, newBotHostId: 'local' })
    const botRows = bots!.data.filter((item) => item.view.botFacts)
    expect(botRows.map((item) => [item.row.displayName, item.view.botFacts?.host])).toEqual([
      ['Atlas', undefined],
      ['Server Atlas', { id: 'runtime:box', label: 'box' }]
    ])
    // Same bot id, two computers: two rows.
    expect(new Set(botRows.map((item) => item.view.sectionListKey)).size).toBe(2)
  })

  it('keeps a down server’s bots in place, dimmed with its word, with nothing under them; up, it names a worker on another server', () => {
    const remote = 'runtime:air' as const
    const other = 'runtime:linux' as const
    const remoteHome = { ...home, hostId: remote }
    const linuxWorker = row('wt-linux', {
      hostId: other,
      repoId: 'linux-repo',
      worktreeInstanceId: 'wt-linux-instance',
      crossStoreParent: {
        childWorkspaceKey: 'worktree:wt-linux',
        childInstanceId: 'wt-linux-instance',
        parent: {
          installationId: 'air',
          workspaceKey: 'folder:atlas-home',
          instanceId: 'atlas-home'
        },
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'explicit' },
        createdAt: 1
      }
    })
    const air = listing({
      hostId: remote,
      hostLabel: 'm4 air',
      offline: 'Disconnected',
      unseen: { 'bot-1': 3 },
      workspaceLineage: {}
    })
    const linux = listing({ hostId: other, hostLabel: 'linux 1', bots: [], workspaceLineage: {} })
    // Its last read's chat, still waiting on you then, is not live while the server is down.
    const lastRead = {
      chats: [
        {
          chatId: 'c-1',
          title: 'Ship it',
          origin: 'side' as const,
          live: 'needs-you' as const,
          lastActiveAt: 0,
          unread: false,
          closed: false,
          tab: true,
          running: [],
          runningTotal: 0,
          finished: [],
          finishedTotal: 0,
          failedTotal: 0
        }
      ],
      workspaceChats: {}
    }
    const inputs = {
      rows: [remoteHome, linuxWorker],
      lineageStores: {
        ownInstallationId: 'mac',
        servers: [
          { hostId: remote, installationId: 'air' },
          { hostId: other, installationId: 'linux' }
        ]
      }
    }
    // Down, the bot is its row alone: no client keeps its chats, so nothing lists under it.
    const [down] = build([air, linux], {
      ...inputs,
      chatTrees: new Map([[hostBotTreeKey(remote, 'bot-1'), lastRead]])
    }).sections
    const [botRow, ...under] = down!.data
    expect(botRow?.view).toMatchObject({
      dimmed: true,
      lineageChildCount: 0,
      botFacts: { host: { label: 'm4 air', word: 'Disconnected' }, dot: 'inactive', foldLive: null }
    })
    expect(botRow?.view.botFacts?.upNext).toBeUndefined()
    expect(under).toEqual([])

    const { offline: _down, ...back } = air
    const [up] = build([back, linux], inputs).sections
    const line = up!.data[1]
    expect(line?.row.worktreeId).toBe('wt-linux')
    expect(line?.view).toMatchObject({ hostContextLabel: 'linux 1', hostContextHostId: other })
    expect(line?.view.dimmed).toBeUndefined()
  })

  it('hides every bot when the paired computer’s Bots switch is off', () => {
    const server = listing({ hostId: 'runtime:box', hostLabel: 'box', workspaceLineage: {} })
    const built = build([listing({ bots: [], createRefusal: 'bots-off' }), server], {
      rows: [home, worker, plain, { ...home, hostId: 'runtime:box' }]
    })
    expect(built.sections).toEqual([])
  })

  it('ends the list with a line for a server never reached, whose bot homes stay out of Projects', () => {
    // A custom profile keeps bots outside ~/.orca/bots; the host's own mark says which rows are homes.
    const serverHome = {
      ...home,
      hostId: 'runtime:air' as const,
      path: '/srv/orca-profile/bots/docs',
      botHome: true as const
    }
    const built = build(
      [listing({ bots: [] }), { kind: 'unreachable', hostId: 'runtime:air', hostLabel: 'm4 air' }],
      { rows: [worker, plain, serverHome] }
    )
    expect(built.sections[0]?.count).toBe(0)
    // "No bots yet." and the unreachable server's line.
    expect(built.sections[0]?.endLines).toHaveLength(2)
    expect(projectRows(built, [worker, plain, serverHome])).toEqual(['wt-flaky', 'wt-main'])
    expect(build([listing({ bots: [] })], { search: 'x' }).sections[0]?.endLines).toBeUndefined()
  })

  it('leaves an older server its folder rows, with no line in the list', () => {
    const server = 'runtime:box' as const
    const serverHome = {
      ...home,
      hostId: server,
      path: '/home/me/.orca/bots/nightly'
    }
    const built = build(
      [listing(), { kind: 'update-needed', hostId: server, hostLabel: 'build-box' }],
      { rows: [home, worker, plain, serverHome] }
    )
    expect(built.sections).toHaveLength(1)
    expect(built.sections[0]?.count).toBe(1)
    expect(built.sections[0]?.endLines).toBeUndefined()
    expect(projectRows(built, [home, worker, plain, serverHome])).toEqual([
      'wt-main',
      'folder:atlas-home'
    ])
  })

  it('leaves a bot’s workspaces in their projects too while the host shows bot-created ones', () => {
    const built = build([listing({ hideBotCreated: false })])
    expect(built.sections[0]?.data.map((item) => item.row.displayName)).toEqual([
      'Atlas',
      'fix-flaky-login-test'
    ])
    expect(projectRows(built)).toEqual(['wt-flaky', 'wt-main'])
  })

  it('fades a paused bot with its workspaces, and rolls up only its own workspaces', () => {
    const child = row('wt-child', {
      displayName: 'child',
      status: 'permission'
    })
    const childLink = {
      worktreeId: 'wt-child',
      worktreeInstanceId: 'i-child',
      parentWorktreeId: 'wt-flaky',
      parentWorktreeInstanceId: 'i-flaky',
      origin: 'manual' as const,
      capture: {
        source: 'manual-action' as const,
        confidence: 'explicit' as const
      },
      createdAt: 1
    }
    const rows = [
      home,
      { ...worker, worktreeInstanceId: 'i-flaky', status: 'active' as const },
      {
        ...child,
        worktreeInstanceId: 'i-child',
        parentWorktreeId: 'wt-flaky',
        lineageWorktreeInstanceId: 'i-child',
        parentWorktreeInstanceId: 'i-flaky'
      },
      plain
    ]
    const running = build([listing({ worktreeLineage: { 'wt-child': childLink } })], { rows })
      .sections[0]
    expect(running?.data.map((item) => item.row.displayName)).toEqual([
      'Atlas',
      'fix-flaky-login-test',
      'child'
    ])
    // The child's needs-you shows on its own line, not on the bot.
    expect(running?.data[0]?.view.botFacts?.status).toBe('active')
    expect(running?.data[0]?.view.lineageChildCount).toBe(1)
    const paused = build([
      listing({
        bots: [
          {
            id: 'bot-1',
            name: 'Atlas',
            folderWorkspaceId: 'atlas-home',
            avatar: null,
            paused: true,
            chatSessionId: null
          }
        ]
      })
    ]).sections[0]
    expect(paused?.data.map((item) => item.view.dimmed)).toEqual([true, true])
  })

  it('changes nothing for a host that lists no bots and takes none', () => {
    for (const built of [build([]), build([listing({ bots: [], createRefusal: 'update' })])]) {
      expect(built.sections).toEqual([])
      expect(projectRows(built)).toEqual(['folder:atlas-home', 'wt-flaky', 'wt-main'])
    }
  })

  describe('workers across machines', () => {
    const stores = {
      ownInstallationId: 'this-mac',
      servers: [{ hostId: 'runtime:windows-2' as const, installationId: 'windows-install' }]
    }
    const recordUnder = (
      child: string,
      parentKey: WorkspaceKey,
      parentInstance: string
    ): CrossStoreWorkspaceLineage => ({
      childWorkspaceKey: `worktree:${child}`,
      childInstanceId: `${child}-instance`,
      parent: { installationId: 'this-mac', workspaceKey: parentKey, instanceId: parentInstance },
      origin: 'orchestration' as const,
      capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
      createdAt: 1
    })
    const remote = (id: string, overrides: Partial<Worktree> = {}) =>
      row(id, {
        hostId: 'runtime:windows-2',
        repoId: 'win-repo',
        worktreeInstanceId: `${id}-instance`,
        ...overrides
      })
    const lineOrder = (built: ReturnType<typeof build>) =>
      built.sections[0]?.data.map((item) => item.row.worktreeId)

    it('lists a local worker’s child on another machine under it', () => {
      const local = { ...worker, worktreeInstanceId: 'local-worker-instance' }
      const child = remote('remote-child', {
        crossStoreParent: recordUnder('remote-child', 'worktree:wt-flaky', 'local-worker-instance')
      })
      const built = build([listing()], { rows: [home, local, child], lineageStores: stores })
      expect(lineOrder(built)).toEqual(['folder:atlas-home', 'wt-flaky', 'remote-child'])
      expect(projectRows(built, [home, local, child])).toEqual([])
    })

    it('orders a remote worker’s children by recent activity', () => {
      const parent = remote('remote-worker', {
        crossStoreParent: recordUnder('remote-worker', 'folder:atlas-home', 'atlas-home')
      })
      const child = (id: string, lastActivityAt: number) =>
        remote(id, {
          worktreeInstanceId: id,
          parentWorktreeId: 'remote-worker',
          lineageWorktreeInstanceId: id,
          parentWorktreeInstanceId: 'remote-worker-instance',
          lastActivityAt
        })
      const built = build([listing({ workspaceLineage: {} })], {
        rows: [home, parent, child('older', 1), child('newer', 100)],
        lineageStores: stores
      })
      expect(lineOrder(built)).toEqual(['folder:atlas-home', 'remote-worker', 'newer', 'older'])
    })

    it('keeps each same-id worker’s children under it on its own machine', () => {
      type Host = 'runtime:windows-2' | 'runtime:third'
      const twin = (hostId: Host) =>
        remote('same-worker-id', {
          hostId,
          repoId: hostId,
          worktreeInstanceId: `worker-${hostId}`,
          crossStoreParent: {
            ...recordUnder('same-worker-id', 'folder:atlas-home', 'atlas-home'),
            childInstanceId: `worker-${hostId}`
          }
        })
      const child = (hostId: Host, id: string) =>
        remote(id, {
          hostId,
          repoId: hostId,
          worktreeInstanceId: id,
          parentWorktreeId: 'same-worker-id',
          lineageWorktreeInstanceId: id,
          parentWorktreeInstanceId: `worker-${hostId}`
        })
      const built = build([listing({ workspaceLineage: {} })], {
        rows: [
          home,
          twin('runtime:windows-2'),
          twin('runtime:third'),
          child('runtime:windows-2', 'win-child'),
          child('runtime:third', 'third-child')
        ],
        lineageStores: {
          ownInstallationId: 'this-mac',
          servers: [
            { hostId: 'runtime:windows-2', installationId: 'windows-install' },
            { hostId: 'runtime:third', installationId: 'third-install' }
          ]
        }
      })
      expect(built.sections[0]?.data.map((item) => [item.row.hostId, item.row.worktreeId])).toEqual(
        [
          ['local', 'folder:atlas-home'],
          ['runtime:windows-2', 'same-worker-id'],
          ['runtime:windows-2', 'win-child'],
          ['runtime:third', 'same-worker-id'],
          ['runtime:third', 'third-child']
        ]
      )
    })
  })
})
