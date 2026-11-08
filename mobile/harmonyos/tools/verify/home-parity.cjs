const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')
const { readHomeCatalog, isHomeAttention } = loadArkts('home/HomeCatalog.ets', [
  'readHomeCatalog',
  'isHomeAttention'
])
const { readHomeUsage, readHomeAutomations, homeAutomationToggleParams, readHomeAutomationRuns } =
  loadArkts('home/HomeAccountUsage.ets', [
    'readHomeUsage',
    'readHomeAutomations',
    'homeAutomationToggleParams',
    'readHomeAutomationRuns'
  ])

test('host sidebar verdict wins over process activity and links its named agent pane', () => {
  const rows = readHomeCatalog(
    JSON.stringify({
      worktrees: [
        {
          worktreeId: 'folder/workspace',
          repo: 'repo',
          displayName: 'Workspace',
          status: 'active',
          sidebarStatus: 'permission',
          hasHostSidebarActivity: false,
          hostId: 'runtime:ssh-host',
          agents: [
            {
              state: 'waiting',
              conversationName: 'Fix issue',
              paneKey: 'pane-3',
              updatedAt: 900,
              parentPaneKey: null
            }
          ]
        }
      ]
    })
  )
  assert.equal(rows[0].state, 'permission')
  assert.equal(rows[0].title, 'Fix issue')
  assert.equal(rows[0].paneKey, 'pane-3')
  assert.equal(rows[0].executionHost, 'runtime:ssh-host')
  assert.equal(isHomeAttention(rows[0]), true)
})

test('background PTYs and read completions do not turn into active agent cards', () => {
  const rows = readHomeCatalog(
    JSON.stringify({
      worktrees: [
        { worktreeId: 'pty', status: 'active', hasHostSidebarActivity: false },
        { worktreeId: 'done-read', sidebarStatus: 'done', unread: false },
        { worktreeId: 'done-unread', sidebarStatus: 'done', unread: true },
        { worktreeId: 'archived', sidebarStatus: 'working', isArchived: true }
      ]
    })
  )
  assert.deepEqual(
    Array.from(rows.filter(isHomeAttention), (row) => row.worktreeId),
    ['done-unread']
  )
  assert.equal(rows[0].state, 'inactive')
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
