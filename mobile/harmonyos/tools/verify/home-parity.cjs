const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')
const { readHomeCatalog } = loadArkts('home/HomeCatalog.ets', ['readHomeCatalog'])
const { buildAgentList, agentsNeedingYou, listedAgents } = loadArkts(
  'home/AgentListModel.ets',
  ['buildAgentList', 'agentsNeedingYou', 'listedAgents'],
  { upstream: require('../../entry/src/main/ets/vendor/agent-list.js') }
)
const { readHomeUsage, readHomeAutomations, homeAutomationToggleParams, readHomeAutomationRuns } =
  loadArkts('home/HomeAccountUsage.ets', [
    'readHomeUsage',
    'readHomeAutomations',
    'homeAutomationToggleParams',
    'readHomeAutomationRuns'
  ])

test('the desktop catalog keeps every listed pane and routes SSH workspaces to their runtime', () => {
  const rows = readHomeCatalog(
    JSON.stringify({
      worktrees: [
        { worktreeId: 'pty', status: 'active', hasHostSidebarActivity: false },
        {
          worktreeId: 'folder/workspace',
          repo: 'repo',
          displayName: 'Workspace',
          sidebarStatus: 'permission',
          hostId: 'runtime:ssh-host',
          agents: [
            {
              paneKey: 'coordinator',
              activity: {
                listed: true,
                status: 'working',
                unread: false,
                clearable: false,
                sortAt: 800,
                title: 'Coordinator'
              }
            },
            {
              paneKey: 'worker',
              activity: {
                listed: true,
                status: 'permission',
                unread: true,
                clearable: false,
                sortAt: 900,
                title: 'Fix issue',
                childOf: 'coordinator'
              }
            },
            { paneKey: 'hidden', activity: { listed: false } },
            { paneKey: 'invalid', conversationName: 7 }
          ]
        },
        { worktreeId: 'archived', isArchived: true, sidebarStatus: 'working' }
      ]
    })
  )
  assert.deepEqual(
    Array.from(rows, (row) => row.state),
    ['inactive', 'permission']
  )
  const catalog = Array.from(rows).flatMap((row) => Array.from(row.agents))
  const host = { id: 'desk', connection: 'connected', catalog, live: true, seenAt: 1000 }
  const view = { groupBy: 'workspace', showWorkers: true, unreadOnly: false }
  const needsYou = agentsNeedingYou([host])
  assert.deepEqual(
    Array.from(needsYou, (row) => row.title),
    ['Fix issue']
  )
  const list = buildAgentList([host], view, '', '')
  assert.deepEqual(
    Array.from(listedAgents(list.sections), (row) => [row.title, row.entry.executionHost]).sort(),
    [
      ['Coordinator', 'runtime:ssh-host'],
      ['Fix issue', 'runtime:ssh-host']
    ]
  )
  const matches = buildAgentList([host], { ...view, unreadOnly: true }, '', 'fix issue')
  assert.deepEqual(
    Array.from(listedAgents(matches.sections), (row) => row.title),
    ['Fix issue']
  )
  const offline = { ...host, connection: 'disconnected', live: false }
  assert.equal(agentsNeedingYou([offline]).length, 0)
  const remembered = listedAgents(buildAgentList([offline], view, '', '').sections)
  assert.equal(remembered.length, 2)
  assert.ok(remembered.every((row) => row.offline && row.unread === undefined && !row.clearable))
})

test('catalog refusal is distinct from a confirmed empty catalog', () => {
  assert.equal(readHomeCatalog('{"unchanged":true}'), null)
  assert.equal(readHomeCatalog('{"worktrees":[{}]}'), null)
  assert.equal(readHomeCatalog('{"worktrees":[]}').length, 0)
})

test('usage follows the selected WSL account without assigning its quota to another login', () => {
  const cards = readHomeUsage(
    JSON.stringify({
      result: {
        type: 'snapshot',
        snapshot: {
          claude: { accounts: [], activeAccountId: null },
          codex: {
            accounts: [
              { id: 'host', email: 'host@example.test' },
              { id: 'wsl', email: 'wsl@example.test' }
            ],
            activeAccountId: 'host',
            activeAccountIdsByRuntime: { host: 'host', wsl: { Ubuntu: 'wsl' } }
          },
          rateLimits: {
            claude: null,
            codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
            codex: { status: 'ok', session: { usedPercent: 35, resetsAt: 1000 } },
            inactiveCodexAccounts: [
              { accountId: 'host', rateLimits: { status: 'ok', session: { usedPercent: 10 } } }
            ]
          }
        }
      }
    })
  )
  assert.equal(cards.find((card) => card.key === 'codex:wsl').windows[0].usedPercent, 35)
  assert.equal(cards.find((card) => card.key === 'codex:host').windows[0].usedPercent, 10)
  assert.equal(readHomeUsage('{"result":{"type":"error"}}'), null)
})

test('automations require one unambiguous owner before showing a row', () => {
  const rows = readHomeAutomations(
    JSON.stringify({
      automations: [
        { id: 'good', name: 'Daily', enabled: true, nextRunAt: 1000 },
        { id: 'ambiguous', name: 'Hidden', enabled: true }
      ],
      items: [
        { automationId: 'good', selector: { kind: 'self' } },
        { automationId: 'ambiguous', selector: { kind: 'self' } },
        {
          automationId: 'ambiguous',
          selector: { kind: 'ssh', targetId: 'ssh-target', targetGeneration: 2 }
        }
      ]
    })
  )
  assert.deepEqual(
    Array.from(rows, (row) => row.id),
    ['good']
  )
  assert.equal(readHomeAutomations('{"error":"unavailable"}'), null)
})

test('automation toggles echo the captured SSH owner generation', () => {
  const rows = readHomeAutomations(
    JSON.stringify({
      automations: [{ id: 'daily', name: 'Daily', enabled: true, nextRunAt: 1000 }],
      items: [
        {
          automationId: 'daily',
          selector: { kind: 'ssh', targetId: 'host-1', targetGeneration: 7 }
        }
      ]
    })
  )
  assert.deepEqual(JSON.parse(homeAutomationToggleParams(rows[0], false)), {
    id: 'daily',
    updates: { enabled: false },
    expectedOwner: { selector: { kind: 'ssh', targetId: 'host-1', targetGeneration: 7 } }
  })
  const runs = readHomeAutomationRuns(
    '{"runs":[{"id":"run-1","title":"Daily","status":"failed","createdAt":1234}]}'
  )
  assert.equal(runs[0].status, 'failed')
})

test('resume locations retain encoded folder and remote pane identity', () => {
  const { resumeFromLocation } = loadArkts('home/HomeResume.ets', ['resumeFromLocation'])
  const resume = resumeFromLocation(
    'a'.repeat(32),
    '/h/' + 'a'.repeat(32) + '/session/folder%2Fworkspace',
    {
      name: 'Folder',
      paneKey: 'pane-1',
      executionHost: 'runtime:ssh-target'
    }
  )
  assert.equal(resume.worktreeId, 'folder/workspace')
  assert.equal(resume.executionHost, 'runtime:ssh-target')
  assert.equal(resume.paneKey, 'pane-1')
  assert.equal(resumeFromLocation('a'.repeat(32), '/h/another/session/worktree', {}), null)
})

test('only the current document can finish its startup and stale faults do not replace it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ShellStartup } = loadArkts('webshell/ShellStartup.ets', ['ShellStartup'])
  const failures = []
  const startup = new ShellStartup((message) => failures.push(message))
  const first = startup.begin()
  const current = startup.begin()
  startup.fail(first, 'old fault')
  assert.equal(startup.complete(first), false)
  assert.equal(startup.complete(current), true)
  startup.fail(current, 'late fault')
  assert.deepEqual(failures, [])
  const failed = startup.begin()
  startup.fail(failed, 'page failed')
  assert.equal(startup.complete(failed), false)
  assert.deepEqual(failures, ['page failed'])
  startup.cancel()
})
