const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')
const { readHomeCatalog } = loadArkts('home/HomeCatalog.ets', ['readHomeCatalog'])
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')
const { activeAgents, buildAgentList, agentsNeedingYou, listedAgents } = loadArkts(
  'home/AgentListModel.ets',
  ['activeAgents', 'buildAgentList', 'agentsNeedingYou', 'listedAgents'],
  { upstream: require('../../entry/src/main/ets/vendor/agent-list.js') }
)

test('agent activity stays scoped to its desktop and a settled write cannot roll back a newer queued choice', async () => {
  const { RpcSuccess } = createRpcPeer()
  const { AgentActivityWrites } = loadArkts(
    'home/AgentActivityWrites.ets',
    ['AgentActivityWrites'],
    { RpcSuccess }
  )
  const queue = new AgentActivityWrites(() => {})
  let finishRead
  let releaseRefresh
  let finishUnread
  let unreadSent
  const first = new Promise((resolve) => {
    finishRead = resolve
  })
  const firstRefresh = new Promise((resolve) => {
    releaseRefresh = resolve
  })
  const last = new Promise((resolve) => {
    finishUnread = resolve
  })
  const unreadStarted = new Promise((resolve) => {
    unreadSent = resolve
  })
  const sent = []
  const pairedA = {
    async request(method, raw) {
      const args = JSON.parse(raw)
      sent.push(['a', method, args])
      if (!args.read) {
        unreadSent()
        return last
      }
      return first
    }
  }
  const pairedB = {
    async request(method, raw) {
      sent.push(['b', method, JSON.parse(raw)])
      return new RpcSuccess('clear', '{"applied":true}')
    }
  }
  const connected = () => true
  const read = queue.write('a', ['same-pane'], true, pairedA, connected, () => firstRefresh)
  const unread = queue.write('a', ['same-pane'], false, pairedA, connected, async () => {})
  const clear = queue.write('b', ['same-pane'], undefined, pairedB, connected, async () => {})
  assert.equal(queue.snapshot('a')['a:same-pane'].unread, true)
  assert.equal(queue.snapshot('b')['b:same-pane'].cleared, true)
  assert.equal(await clear, '')
  assert.deepEqual(sent, [
    ['a', 'agentActivity.setRead', { paneKeys: ['same-pane'], read: true }],
    ['b', 'agentActivity.clear', { paneKeys: ['same-pane'] }]
  ])
  finishRead(new RpcSuccess('read', '{"applied":true}'))
  await unreadStarted
  releaseRefresh()
  await read
  assert.equal(queue.snapshot('a')['a:same-pane'].unread, true)
  finishUnread({ errorCode: 'timeout', errorMessage: 'Timed out' })
  assert.equal(await unread, 'timeout')
  assert.equal(queue.snapshot('a')['a:same-pane'], undefined)
})

test('agent activity sends local and delegated pane changes to their exact owners', async () => {
  const peer = createRpcPeer()
  const { AgentActivityWrites, planAgentActivity } = loadArkts(
    'home/AgentActivityWrites.ets',
    ['AgentActivityWrites', 'planAgentActivity'],
    { RpcSuccess: peer.RpcSuccess }
  )
  const entry = (paneKey, owner) => ({
    worktreeId: `workspace-${paneKey}`,
    executionHostId: owner || 'local',
    executionHost: owner,
    agent: { paneKey }
  })
  const local = entry('local-pane', '')
  const delegated = entry('remote-pane', 'runtime:server%2Fone')
  const duplicate = entry('shared-pane', '')
  const moved = entry('moved-pane', '')
  const row = (value) => ({ hostId: 'paired-desktop', unread: true, entry: value })
  const plan = planAgentActivity([local, delegated, duplicate, moved].map(row), true, () => [
    local,
    delegated,
    duplicate,
    entry('shared-pane', 'runtime:server%2Fone'),
    entry('moved-pane', 'runtime:server%2Fone')
  ])
  assert.equal(plan.unavailable, true)

  const queue = new AgentActivityWrites(() => {})
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://127.0.0.1:6768', 'token', 'key')
  try {
    const run = (batch) =>
      queue.write(
        batch.hostId,
        batch.paneKeys,
        true,
        client,
        () => true,
        async () => {},
        batch.executionHost || undefined
      )
    const writes = Array.from(plan.batches, run)
    const sent = () =>
      peer.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.method === 'agentActivity.setRead')
    for (const [index, paneKey, executionHost] of [
      [0, 'local-pane', undefined],
      [1, 'remote-pane', 'runtime:server%2Fone']
    ]) {
      await new Promise(setImmediate)
      const request = sent()[index]
      assert.deepEqual(request.params, { paneKeys: [paneKey], read: true })
      assert.equal(request.executionHost, executionHost)
      peer.receiveText(JSON.stringify({ id: request.id, ok: true, result: { applied: true } }))
    }
    assert.deepEqual(await Promise.all(writes), ['', ''])
    assert.equal(sent().length, 2)
  } finally {
    client.close()
  }
})

test('agents in matching local and SSH workspaces remain in separate workspace and project groups', () => {
  const catalog = readHomeCatalog(
    JSON.stringify({
      worktrees: ['local', 'ssh:studio'].map((hostId, index) => ({
        hostId,
        worktreeId: 'repo-a::/srv/project',
        displayName: 'Project',
        repoId: 'repo-a',
        repo: 'Same project name',
        agents: [
          {
            paneKey: index === 0 ? 'local-pane' : 'ssh-pane',
            state: 'done',
            activity: {
              listed: true,
              title: 'Task',
              status: 'done',
              sortAt: 1000,
              unread: false,
              clearable: true
            }
          }
        ]
      }))
    })
  ).flatMap((worktree) => worktree.agents)
  const hosts = [{ id: 'desktop', connection: 'connected', catalog, live: true, loading: false }]
  for (const groupBy of ['workspace', 'project']) {
    const groups = buildAgentList(
      hosts,
      { groupBy, unreadOnly: false, showWorkers: true },
      '',
      ''
    ).sections
    assert.deepEqual(
      Array.from(groups, (group) => Array.from(group.rows, (row) => row.entry.agent.paneKey)),
      [['local-pane'], ['ssh-pane']]
    )
  }
})
const { readHomeUsage, readHomeAutomations, homeAutomationToggleParams, readHomeAutomationRuns } =
  loadArkts('home/HomeAccountUsage.ets', [
    'readHomeUsage',
    'readHomeAutomations',
    'homeAutomationToggleParams',
    'readHomeAutomationRuns'
  ])

test('the desktop catalog keeps every listed pane and the workspace runtime target', () => {
  const rows = readHomeCatalog(
    JSON.stringify({
      worktrees: [
        { worktreeId: 'pty', status: 'active', hasHostSidebarActivity: false },
        {
          worktreeId: 'folder/workspace',
          repo: 'repo',
          displayName: 'Workspace',
          status: 'inactive',
          unread: true,
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
    Array.from(rows, (row) => row.active),
    [false, true]
  )
  const catalog = Array.from(rows).flatMap((row) => Array.from(row.agents))
  const host = { id: 'desk', connection: 'connected', catalog, live: true, seenAt: 1000 }
  const view = { groupBy: 'workspace', showWorkers: true, unreadOnly: false }
  const needsYou = agentsNeedingYou([host])
  assert.deepEqual(
    Array.from(needsYou, (row) => row.title),
    ['Fix issue']
  )
  assert.deepEqual(
    Array.from(activeAgents([host]), (row) => row.title),
    ['Fix issue', 'Coordinator']
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
  assert.equal(activeAgents([offline]).length, 0)
  const remembered = listedAgents(buildAgentList([offline], view, '', '').sections)
  assert.equal(remembered.length, 2)
  assert.ok(remembered.every((row) => row.offline && row.unread === undefined && !row.clearable))
})

test('catalog refusal is distinct from a confirmed empty catalog', () => {
  assert.equal(readHomeCatalog('{"unchanged":true}'), null)
  assert.equal(readHomeCatalog('{"worktrees":[{}]}'), null)
  assert.equal(readHomeCatalog('{"worktrees":[]}').length, 0)
})

test('the worktree wire keeps each host identity and flags an archived twin before opening a session', () => {
  const rows = readHomeCatalog(
    JSON.stringify({
      worktrees: [
        {
          worktreeId: 'repo-a::/srv/app',
          repoId: 'repo-a',
          hostId: 'local',
          identity: {
            key: 'wt2:local:inst-local',
            executionHostId: 'local',
            instanceId: 'inst-local'
          },
          agents: [{ paneKey: 'desktop-pane' }]
        },
        {
          worktreeId: 'repo-a::/srv/app',
          repoId: 'repo-a',
          hostId: 'ssh:server',
          identity: {
            key: 'wt2:ssh%3Aserver:inst-ssh',
            executionHostId: 'ssh:server',
            instanceId: 'inst-ssh'
          },
          isArchived: true,
          agents: [{ paneKey: 'archived-pane' }]
        },
        {
          worktreeId: 'repo-a::/srv/unique',
          repoId: 'repo-a',
          hostId: 'ssh:server',
          identity: {
            key: 'wt2:ssh%3Aserver:inst-unique',
            executionHostId: 'ssh:server',
            instanceId: 'inst-unique'
          },
          agents: [{ paneKey: 'ssh-pane' }]
        },
        {
          worktreeId: 'repo-b::/work/app',
          repoId: 'repo-b',
          hostId: 'runtime:server-a',
          identity: {
            key: 'wt2:local:inst-server',
            executionHostId: 'local',
            instanceId: 'inst-server'
          },
          agents: [{ paneKey: 'runtime-pane' }]
        },
        {
          worktreeId: 'repo-c::/work/unresolved',
          repoId: 'repo-c',
          hostId: 'runtime:unresolved-owner',
          agents: [{ paneKey: 'unresolved-pane' }]
        }
      ]
    })
  )
  assert.deepEqual(
    Array.from(rows).flatMap((row) =>
      Array.from(row.agents, (entry) => [
        entry.agent.paneKey,
        entry.worktreeId,
        entry.repoId,
        entry.executionHostId,
        entry.workspaceIdentityKey,
        entry.executionHost,
        entry.ambiguousWorkspace
      ])
    ),
    [
      ['desktop-pane', 'repo-a::/srv/app', 'repo-a', 'local', 'wt2:local:inst-local', '', true],
      [
        'ssh-pane',
        'repo-a::/srv/unique',
        'repo-a',
        'ssh:server',
        'wt2:ssh%3Aserver:inst-unique',
        '',
        undefined
      ],
      [
        'runtime-pane',
        'repo-b::/work/app',
        'repo-b',
        'runtime:server-a',
        'wt2:local:inst-server',
        'runtime:server-a',
        undefined
      ],
      [
        'unresolved-pane',
        'repo-c::/work/unresolved',
        'repo-c',
        'runtime:unresolved-owner',
        undefined,
        '',
        true
      ]
    ]
  )
})

test('usage follows the selected runtime account, including host-only snapshots from older desktops', () => {
  const snapshot = {
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
  for (const payload of [snapshot, { result: { type: 'snapshot', snapshot } }]) {
    const cards = readHomeUsage(JSON.stringify(payload))
    assert.deepEqual(
      Array.from(cards, (card) => [card.key, card.active, card.windows[0]?.usedPercent]),
      [
        ['codex:wsl', true, 35],
        ['codex:host', false, 10]
      ]
    )
  }
  delete snapshot.rateLimits.codexTarget
  snapshot.codex.activeAccountId = 'wsl'
  const hostCards = readHomeUsage(JSON.stringify(snapshot))
  assert.deepEqual(
    Array.from(hostCards, (card) => [card.key, card.active, card.windows[0]?.usedPercent]),
    [
      ['codex:host', true, 35],
      ['codex:wsl', false, undefined]
    ]
  )
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

test('page faults remount once per visit while renderer recovery renews after a paint', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ShellStartup } = loadArkts('webshell/ShellStartup.ets', ['ShellStartup'])
  const startup = new ShellStartup(() => {})
  assert.equal(startup.allowRemount('page'), true)
  assert.equal(startup.allowRemount('renderer'), true)
  assert.equal(startup.allowRemount('renderer'), false)
  startup.complete(startup.begin())
  assert.equal(startup.allowRemount('renderer'), true)
  assert.equal(startup.allowRemount('page'), false)
  startup.resetRecovery()
  assert.equal(startup.allowRemount('page'), true)
  startup.cancel()
})
