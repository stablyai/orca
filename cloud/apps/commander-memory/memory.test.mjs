import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMemoryServer } from './server.mjs'
import { openStore } from './store.mjs'

async function listen(server) {
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve)
  )
  return 'http://127.0.0.1:' + server.address().port
}
const close = (server) => new Promise((resolve) => server.close(resolve))

async function setupMemory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-memory-'))
  const accounts = {
    laptop: { userId: 'A', activeOrgId: 'org' },
    phone: { userId: 'A', activeOrgId: 'org' },
    bob: { userId: 'B', activeOrgId: 'org' },
    elsewhere: { userId: 'A', activeOrgId: 'team' },
    malformed: {}
  }
  const authority = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/desktop/auth/capabilities')
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {})
    const cloud = accounts[req.headers.authorization?.split(' ')[1]]
    res.writeHead(cloud ? 200 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ cloud, capabilities: {} }))
  })
  const capabilitiesEndpoint = (await listen(authority)) + '/v1/desktop/auth/capabilities'
  const config = { capabilitiesEndpoint, databasePath: join(dir, 'memory.sqlite') }
  let service = createMemoryServer(config)
  let root = (await listen(service)) + '/v1/commander/memory'
  t.after(async () => {
    await close(service)
    await close(authority)
    await rm(dir, { recursive: true, force: true })
  })
  const call = async (token, path = '', body) => {
    const res = await fetch(root + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, ...(await res.json()) }
  }
  return {
    call,
    async restart() {
      await close(service)
      service = createMemoryServer(config)
      root = (await listen(service)) + '/v1/commander/memory'
    }
  }
}

test('accounts share wiki history across devices with durable compare-and-swap, scoped delegation and idempotent writes', async (t) => {
  const { call, restart } = await setupMemory(t)
  const edit = {
    pageId: 'guide',
    requestId: 'r1',
    kind: 'guideline',
    title: 'Tests',
    body: 'Run checks',
    expectedVersion: 0,
    links: ['release'],
    actor: { type: 'commander', id: 'spoof' }
  }
  assert.equal((await call('malformed')).status, 503)
  assert.equal((await call('invalid')).status, 401)
  const first = await call('laptop', '/human', edit)
  assert.equal(first.status, 200)
  assert.deepEqual(first.page.actor, { type: 'human', id: 'A' })
  assert.deepEqual((await call('phone', '/pages/guide')).history, [first.page])
  assert.deepEqual((await call('bob')).pages, [])
  assert.equal((await call('elsewhere', '/pages/guide')).status, 404)
  const changes = await Promise.all(
    ['phone', 'laptop'].map((device, i) =>
      call(device, '/human', {
        ...edit,
        requestId: 'race-' + i,
        body: 'revision ' + i,
        expectedVersion: 1
      })
    )
  )
  assert.deepEqual(changes.map((r) => r.status).sort(), [200, 409])
  assert.equal((await call('phone', '/human', { ...edit, title: 'changed' })).status, 409)
  assert.deepEqual((await call('phone', '/human', edit)).page, first.page)
  for (const type of ['commander', 'agent']) {
    const delegation = await call('laptop', '/delegations', {
      type,
      id: 'worker',
      projectId: 'github:owner/repo'
    })
    assert.equal(delegation.status, 200)
    const token = delegation.token
    assert.equal((await call(token, '/human', edit)).status, 403)
    assert.equal(
      (await call(token, '/delegations', { type, id: 'second', projectId: 'else' })).status,
      403
    )
    assert.equal(
      (
        await call(token, '/' + type, {
          ...edit,
          pageId: 'worker-guide',
          projectId: 'github:owner/repo'
        })
      ).status,
      403
    )
    assert.equal(
      (
        await call(token, '/' + type, {
          ...edit,
          pageId: 'off-scope',
          projectId: 'other',
          kind: 'decision'
        })
      ).status,
      403
    )
    const state = {
      ...edit,
      pageId: type + '-run',
      projectId: 'github:owner/repo',
      kind: 'decision'
    }
    assert.deepEqual((await call(token, '/' + type, state)).page.actor, { type, id: 'worker' })
    const listing = await call(token)
    assert.deepEqual(listing.actor, { type, id: 'worker' })
    assert.equal(listing.projectId, 'github:owner/repo')
    assert.equal(
      listing.pages.some((p) => p.pageId === 'guide'),
      true
    )
    assert.equal(
      (
        await call(token, '/' + type, {
          pageId: 'guide',
          expectedVersion: 2,
          requestId: 'erase',
          deleted: true
        })
      ).status,
      403
    )
    const humanEdit = await call('phone', '/human', {
      ...state,
      requestId: 'edit-' + type,
      expectedVersion: 1,
      body: 'human update'
    })
    assert.deepEqual(humanEdit.page.createdBy, { type, id: 'worker' })
    assert.equal(
      (await call(token, '/' + type, { ...state, requestId: 'again', expectedVersion: 2 })).status,
      403
    )
  }
  const del = await call('phone', '/human', {
    pageId: 'guide',
    expectedVersion: 2,
    requestId: 'delete',
    deleted: true
  })
  assert.equal(del.page.deleted, true)
  await restart()
  assert.equal((await call('laptop', '/pages/guide')).history.length, 3)
  const restored = await call('laptop', '/human', {
    ...edit,
    requestId: 'restore',
    expectedVersion: 3
  })
  assert.equal(restored.page.deleted, false)
  assert.equal(restored.page.version, 4)
  assert.deepEqual((await call('laptop', '/human', edit)).page, first.page)
})

test('delegated workers reuse one current project rule and record an immutable, retryable decision', async (t) => {
  const { call, restart } = await setupMemory(t)
  for (const account of ['laptop', 'bob']) {
    assert.equal(
      (await call(account, '/preferences/settings', { enabled: true, expectedVersion: 0 })).status,
      200
    )
  }
  const projectId = 'github:a/sdk'
  const question = 'Which suite should I run?'
  const answer = 'Run unit tests first.'
  const ask = (token, requestId, text = question) =>
    call(token, '/preferences/ask', { requestId, question: text })
  const delegate = async (account, type, id, project = projectId) => {
    const result = await call(account, '/delegations', { type, id, projectId: project })
    assert.equal(result.status, 200)
    return result.token
  }
  const agent = await delegate('laptop', 'agent', 'worker')
  const commander = await delegate('laptop', 'commander', 'worker')
  const rule = {
    kind: 'guideline',
    title: 'Recurring answer',
    body: JSON.stringify({ version: 1, question, answer }),
    pageId: 'suite',
    requestId: 'create-rule',
    expectedVersion: 0,
    projectId
  }
  const missing = { status: 200, matched: false, reason: 'missing' }
  const conflict = { status: 200, matched: false, reason: 'conflict' }
  assert.deepEqual(await ask(agent, 'early'), missing)
  assert.equal((await call('phone', '/human', rule)).status, 200)
  assert.deepEqual(await ask(agent, 'early'), missing)
  assert.equal((await ask('laptop', 'ask')).status, 403)
  assert.equal(
    (await call(agent, '/preferences/ask', { question, requestId: 'ask', projectId })).status,
    400
  )
  assert.equal((await ask(agent, 'spaced', ' ' + question)).status, 400)
  assert.equal((await ask(agent, 'long', 'x'.repeat(501))).status, 400)
  assert.deepEqual(await ask(agent, 'lower', question.toLowerCase()), missing)

  // A wiki write with the same request ID cannot impersonate or preempt the decision.
  assert.equal(
    (
      await call(agent, '/agent', {
        ...rule,
        kind: 'note',
        pageId: 'worker-note',
        requestId: 'ask'
      })
    ).status,
    200
  )
  const [first, simultaneous] = await Promise.all([ask(agent, 'ask'), ask(agent, 'ask')])
  assert.equal(first.status, 200)
  assert.equal(first.matched, true)
  assert.equal(first.answer, answer)
  assert.equal(first.rulePageId, 'suite')
  assert.equal(first.ruleVersion, 1)
  assert.deepEqual(simultaneous, first)
  assert.deepEqual(
    await call(agent, '/preferences/ask', {
      requestId: 'ask',
      question,
      expectedProjectId: projectId
    }),
    first
  )
  assert.equal(
    (
      await call(agent, '/preferences/ask', {
        question,
        requestId: 'ask',
        expectedActorType: 'commander'
      })
    ).status,
    403
  )
  for (const wrongProject of ['github:a/api', null, 42])
    assert.equal(
      (
        await call(agent, '/preferences/ask', {
          requestId: 'ask',
          question,
          expectedProjectId: wrongProject
        })
      ).status,
      403
    )
  const decision = (await call('phone', '/pages/' + first.decisionPageId)).page
  assert.equal(decision.kind, 'decision')
  assert.equal(decision.recurringAnswerReceipt, true)
  assert.deepEqual(decision.links, ['suite'])
  assert.deepEqual(decision.actor, { type: 'agent', id: 'worker' })
  assert.equal(decision.projectId, projectId)
  for (const detail of [question, answer, 'agent worker', 'suite (revision 1)'])
    assert.ok(decision.body.includes(detail))
  assert.equal(
    (
      await call('phone', '/human', {
        pageId: first.decisionPageId,
        expectedVersion: 1,
        requestId: 'erase-audit',
        deleted: true
      })
    ).status,
    403
  )
  assert.equal(
    (
      await call('phone', '/human', {
        ...rule,
        kind: 'decision',
        pageId: 'preference-decision-forged',
        requestId: 'fake'
      })
    ).status,
    403
  )
  assert.equal((await ask(agent, 'ask', 'Another question?')).status, 409)
  for (const peer of [
    await delegate('bob', 'agent', 'worker'),
    await delegate('laptop', 'agent', 'worker', 'github:a/api')
  ])
    assert.deepEqual(await ask(peer, 'ask'), missing)
  const commanderResult = await ask(commander, 'ask')
  assert.equal(commanderResult.answer, answer)
  assert.notEqual(commanderResult.decisionPageId, first.decisionPageId)

  assert.equal(
    (
      await call('phone', '/human', {
        ...rule,
        pageId: 'second',
        requestId: 'duplicate'
      })
    ).status,
    200
  )
  assert.deepEqual(await ask(agent, 'duplicate-ask'), conflict)
  for (const pageId of ['suite', 'second'])
    assert.equal(
      (
        await call('phone', '/human', {
          pageId,
          expectedVersion: 1,
          requestId: 'revoke-' + pageId,
          deleted: true
        })
      ).status,
      200
    )
  await restart()
  assert.deepEqual(await ask(await delegate('phone', 'agent', 'worker'), 'ask'), first)
  assert.deepEqual(await ask(agent, 'duplicate-ask'), conflict)
  assert.deepEqual(await ask(agent, 'after-revocation'), missing)
  assert.equal(
    (
      await call('phone', '/human', {
        ...rule,
        expectedVersion: 2,
        requestId: 'replace-rule',
        body: JSON.stringify({ version: 1, question, answer: 'Run integration tests.' })
      })
    ).status,
    200
  )
  const replacement = await ask(agent, 'after-replace')
  assert.equal(replacement.ruleVersion, 3)
  assert.equal(replacement.answer, 'Run integration tests.')
  assert.deepEqual(await ask(agent, 'ask'), first)
})

test('global, renamed, malformed and non-guideline Memory pages cannot authorize an answer', async (t) => {
  const { call } = await setupMemory(t)
  assert.equal(
    (await call('laptop', '/preferences/settings', { enabled: true, expectedVersion: 0 })).status,
    200
  )
  const projectId = 'github:a/sdk'
  const token = (await call('laptop', '/delegations', { type: 'agent', id: 'worker', projectId }))
    .token
  const question = 'What now?'
  const body = { version: 1, question, answer: 'Check the docs' }
  const rule = {
    kind: 'guideline',
    title: 'Recurring answer',
    body: JSON.stringify(body),
    pageId: 'renamed',
    requestId: 'create',
    expectedVersion: 0,
    projectId
  }
  assert.equal((await call('phone', '/human', rule)).status, 200)
  assert.equal(
    (
      await call('phone', '/human', {
        ...rule,
        requestId: 'rename',
        title: 'Old rule',
        expectedVersion: 1
      })
    ).status,
    200
  )
  const nonRules = [
    { projectId: null },
    { kind: 'note' },
    { title: 'recurring answer' },
    { body: 'Check the docs' },
    ...[
      { extra: true },
      { version: 2 },
      { answer: ' ' },
      { question: question + ' ' },
      { answer: 'leading or trailing ' },
      { answer: 'x'.repeat(2001) }
    ].map((change) => ({ body: JSON.stringify({ ...body, ...change }) }))
  ]
  for (const [index, changes] of nonRules.entries())
    assert.equal(
      (
        await call('laptop', '/human', {
          ...rule,
          ...changes,
          pageId: 'unused-' + index,
          requestId: 'create-' + index
        })
      ).status,
      200
    )
  assert.deepEqual(await call(token, '/preferences/ask', { question, requestId: 'ask' }), {
    status: 200,
    matched: false,
    reason: 'missing'
  })
})

test('the account switch is scoped to a user and organization and serializes changes across devices', async (t) => {
  const { call, restart } = await setupMemory(t)
  const settings = (token, body) => call(token, '/preferences/settings', body)
  const initial = { status: 200, enabled: false, version: 0 }
  assert.deepEqual(await settings('laptop'), initial)
  assert.deepEqual(await settings('phone', { enabled: false, expectedVersion: 0 }), initial)
  for (const type of ['agent', 'commander']) {
    const { token } = await call('laptop', '/delegations', { type, id: 'worker', projectId: 'sdk' })
    assert.equal((await settings(token)).status, 403)
    assert.equal((await settings(token, { enabled: true, expectedVersion: 0 })).status, 403)
  }
  for (const invalid of [
    { enabled: true },
    { enabled: 'true', expectedVersion: 0 },
    { enabled: true, expectedVersion: -1 },
    { enabled: true, expectedVersion: 0, tenant: 'bob' }
  ])
    assert.equal((await settings('phone', invalid)).status, 400)
  const on = { status: 200, enabled: true, version: 1 }
  const enable = { enabled: true, expectedVersion: 0 }
  const writes = await Promise.all(['laptop', 'phone'].map((token) => settings(token, enable)))
  assert.deepEqual(writes, [on, on])
  assert.equal((await settings('phone', { enabled: false, expectedVersion: 0 })).status, 409)
  assert.equal((await settings('phone', { enabled: true, expectedVersion: 2 })).status, 409)
  await restart()
  assert.deepEqual(await settings('phone'), on)
  assert.deepEqual(await settings('bob'), initial)
  assert.deepEqual(await settings('elsewhere'), initial)
  assert.deepEqual(await settings('laptop', { enabled: false, expectedVersion: 1 }), {
    status: 200,
    enabled: false,
    version: 2
  })
  assert.equal((await settings('phone', enable)).status, 409)
})

test('turning recurring answers off suspends existing replays and leaves pending asks and rules intact', async (t) => {
  const { call } = await setupMemory(t)
  const projectId = 'github:a/sdk'
  const { token } = await call('laptop', '/delegations', { type: 'agent', id: 'worker', projectId })
  const question = 'Where should I record results?'
  const ask = (requestId, checks) =>
    call(token, '/preferences/ask', { question, requestId, ...checks })
  const disabled = { status: 200, matched: false, reason: 'disabled' }
  assert.equal((await ask('test', { expectedProjectId: 'github:b/site' })).status, 403)
  assert.equal((await ask('test', { expectedActorType: 'commander' })).status, 403)
  assert.equal(
    (await call('laptop', '/preferences/ask', { question, requestId: 'test' })).status,
    403
  )
  assert.equal(
    (
      await call('laptop', '/human', {
        projectId,
        kind: 'guideline',
        title: 'Recurring answer',
        pageId: 'results',
        requestId: 'r1',
        expectedVersion: 0,
        body: JSON.stringify({ version: 1, question, answer: 'In the wiki.' })
      })
    ).status,
    200
  )
  const receipts = async () =>
    (await call('laptop')).pages.filter((page) => page.recurringAnswerReceipt)
  assert.deepEqual(await ask('early'), disabled)
  assert.deepEqual(await receipts(), [])
  assert.equal(
    (await call('phone', '/preferences/settings', { enabled: true, expectedVersion: 0 })).status,
    200
  )
  const first = await ask('early')
  assert.equal(first.answer, 'In the wiki.')
  assert.equal(
    (await call('phone', '/preferences/settings', { enabled: false, expectedVersion: 1 })).status,
    200
  )
  assert.deepEqual(await ask('early'), disabled)
  assert.deepEqual(await ask('later'), disabled)
  assert.deepEqual(
    (await receipts()).map((page) => page.pageId),
    [first.decisionPageId]
  )
  assert.equal((await call('laptop', '/pages/results')).page.version, 1)
  assert.equal(
    (await call('phone', '/preferences/settings', { enabled: true, expectedVersion: 2 })).status,
    200
  )
  assert.deepEqual(await ask('early'), first)
  const later = await ask('later')
  assert.equal(later.answer, 'In the wiki.')
  assert.notEqual(later.decisionPageId, first.decisionPageId)
})

test('the owner browses paged, scoped summaries and resolves linked pages without reading every revision body', async (t) => {
  const { call } = await setupMemory(t)
  const page = {
    kind: 'note',
    title: 'Progress',
    body: 'private summary text',
    expectedVersion: 0,
    projectId: 'project-a',
    links: ['related']
  }
  const write = (pageId, fields = {}) =>
    call('laptop', '/human', { ...page, pageId, requestId: pageId, ...fields })
  for (let n = 0; n < 51; n++) await write('page-' + String(n).padStart(2, '0'))
  await write('rule', {
    projectId: 'project-b',
    kind: 'guideline',
    title: 'Recurring answer',
    body: '{"version":1,"question":"Which runtime?","answer":"Öld runtime 24"}'
  })
  await write('unrelated', {
    projectId: 'project-b',
    kind: 'guideline',
    title: 'Recurring answer',
    body: 'Ordinary notes'
  })
  await write('handoff-A0000000-0123-4567-ABCD-000000000000')
  await write('handoff-incorrect')
  await write('removed', { projectId: 'archived' })
  await call('phone', '/human', {
    pageId: 'removed',
    requestId: 'delete',
    expectedVersion: 1,
    deleted: true
  })
  const first = await call('laptop', '/index?projectId=project-a')
  assert.equal(first.status, 200)
  assert.equal(first.pages.length, 50)
  assert.equal(first.next, 'page-47')
  assert.deepEqual(first.projects, ['project-a', 'project-b'])
  assert.equal(JSON.stringify(first.pages).includes('private summary text'), false)
  assert.deepEqual(
    (await call('phone', '/index?after=page-47&projectId=project-a')).pages.map((p) => p.pageId),
    ['page-48', 'page-49', 'page-50']
  )
  const last = await call('phone', '/index?order=recent')
  const more = await call('phone', '/index?order=recent&after=' + encodeURIComponent(last.next))
  assert.equal(last.pages.length, 50)
  assert.equal(more.next, null)
  assert.equal(new Set([...last.pages, ...more.pages].map((p) => p.pageId)).size, 55)
  const active = await call(
    'phone',
    '/index?recurringOnly=true&q=%C3%B6ld&includeDeletedProjects=true'
  )
  assert.deepEqual(active.projects, ['archived', 'project-a', 'project-b'])
  assert.deepEqual(
    active.pages.map((p) => [p.pageId, p.recurringQuestion, p.createdBy, p.actor]),
    [['rule', 'Which runtime?', { type: 'human', id: 'A' }, { type: 'human', id: 'A' }]]
  )
  assert.deepEqual(
    (await call('phone', '/index?handoffsOnly=true')).pages.map((p) => p.pageId),
    ['handoff-A0000000-0123-4567-ABCD-000000000000']
  )
  assert.deepEqual(
    (await call('phone', '/index?id=removed&id=rule&id=unknown&includeDeleted=true')).pages.map(
      (p) => [p.pageId, p.deleted]
    ),
    [
      ['removed', true],
      ['rule', false]
    ]
  )
  assert.deepEqual((await call('bob', '/index?id=rule')).pages, [])
  assert.deepEqual((await call('elsewhere', '/index')).projects, [])
  const grant = await call('laptop', '/delegations', {
    projectId: 'project-a',
    type: 'agent',
    id: 'tester'
  })
  assert.equal((await call(grant.token, '/index')).status, 403)
  assert.equal((await call('laptop', '/index?order=recent&after=page-47')).status, 400)
  assert.equal((await call('laptop', '/index?' + Array(51).fill('id=rule').join('&'))).status, 400)
})

test('legacy revisions backfill once and older writers remain visible in the same transaction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-page-index-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'memory.sqlite')
  const db = new DatabaseSync(file)
  t.after(() => db.close())
  db.exec(`CREATE TABLE revisions (
    tenant TEXT NOT NULL,page TEXT NOT NULL,version INTEGER NOT NULL,actor TEXT NOT NULL,
    request TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,
    PRIMARY KEY(tenant,page,version), UNIQUE(tenant,actor,request));`)
  const append = db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?,?,?)')
  const actor = { type: 'human', id: 'A' }
  const owner = { tenant: 'old-tenant', actor }
  function legacyWrite(pageId, version, title) {
    const request = pageId + '-' + version
    append.run(
      owner.tenant,
      pageId,
      version,
      'human',
      request,
      '',
      JSON.stringify({
        pageId,
        version,
        kind: 'decision',
        title,
        body: 'Confidential',
        links: [],
        deleted: false,
        createdAt: '2026-11-23T00:00:00.000Z',
        actor,
        createdBy: actor,
        projectId: 'legacy',
        requestId: request
      })
    )
  }
  legacyWrite('p', 1, 'before')
  legacyWrite('p', 2, 'current')
  const store = openStore(file)
  t.after(() => store.close())
  assert.deepEqual(
    store.index(owner, new URLSearchParams()).pages.map((p) => p.title),
    ['current']
  )
  db.exec('BEGIN IMMEDIATE')
  legacyWrite('p', 3, 'after')
  assert.deepEqual(
    store.index(owner, new URLSearchParams()).pages.map((p) => p.title),
    ['current']
  )
  db.exec('COMMIT')
  assert.deepEqual(
    store.index(owner, new URLSearchParams()).pages.map((p) => [p.version, p.title]),
    [[3, 'after']]
  )
  for (let n = 0; n < 51; n++) legacyWrite('tie-' + String(n).padStart(2, '0'), 1, 'same timestamp')
  assert.equal(
    store.index(owner, new URLSearchParams({ order: 'recent' })).next,
    '2026-11-23T00:00:00.000Z|tie-48'
  )
  assert.deepEqual(
    store
      .index(
        owner,
        new URLSearchParams({ order: 'recent', after: '2026-11-23T00:00:00.000Z|tie-48' })
      )
      .pages.map((p) => p.pageId),
    ['tie-49', 'tie-50']
  )
})

test('the handoff picker validates current Markdown and guided resume packs only eligible current guidelines', async (t) => {
  const { call } = await setupMemory(t)
  const projectId = 'github:owner/repo'
  const write = async (pageId, fields, device = 'laptop') => {
    const result = await call(device, '/human', {
      kind: 'guideline',
      title: 'A',
      body: 'one',
      projectId,
      expectedVersion: 0,
      pageId,
      requestId: pageId,
      ...fields
    })
    assert.equal(result.status, 200)
  }
  const id = (digit) => 'handoff-aaaaaaaa-bbbb-cccc-dddd-' + digit.repeat(12)
  const encodedBoundary = 'x'.repeat(3987) + '\n\\## Next step'
  const handoff = {
    kind: 'note',
    body: `## Progress\n\n${encodedBoundary}\n\n## Next step\n\nContinue`
  }
  await write(id('1'), handoff)
  await write(id('2'), { ...handoff, body: handoff.body + '\n\n## Next step\n\nUnclear' })
  await write(id('3'), { ...handoff, body: 'Ordinary wiki note' })
  await write(id('4'), {
    ...handoff,
    body: '## Progress\n\n' + '🙂'.repeat(2001) + '\n\n## Next step\n\nGo'
  })
  await write(id('5'), handoff)
  await write(id('5'), { deleted: true, expectedVersion: 1, requestId: 'removed-handoff' })
  const strict = await call('phone', '/handoffs-index?order=recent&includeDeleted=true')
  assert.deepEqual(
    strict.pages.map(({ pageId }) => pageId),
    [id('1')]
  )
  assert.equal(strict.pages[0].body, undefined)
  assert.equal(strict.next, null)
  assert.equal((await call('laptop', '/index?handoffsOnly=true')).pages.length, 4)

  const guidance = '/worker-guidance?' + new URLSearchParams({ projectId })
  const query = (token) => call(token, guidance)
  // Put an oversized entry between two eligible records. The final two fill the budget exactly.
  await write('a', { body: 'x'.repeat(7000) })
  await write('b', { body: '🙂'.repeat(501) })
  await write('c', { projectId: null, body: 'x'.repeat(982) })
  await write('d', { title: 'Recurring answer', body: 'hidden capability' })
  await write('e', { projectId: 'github:other/repo' })
  await write('f', {})
  await write('f', { deleted: true, expectedVersion: 1, requestId: 'removed-guideline' })
  await write('g', {}, 'elsewhere')
  await write('h', {}, 'bob')
  const expected = ['A (v1)\n' + 'x'.repeat(7000), 'A (v1)\n' + 'x'.repeat(982)]
  assert.deepEqual(await query('phone'), { status: 200, guidelines: expected, truncated: true })
  await write('b', { title: 'Recurring answer', expectedVersion: 1, requestId: 'retitle' })
  assert.deepEqual(await query('phone'), { status: 200, guidelines: expected, truncated: false })
  for (const device of ['bob', 'elsewhere'])
    assert.deepEqual(await query(device), {
      status: 200,
      guidelines: ['A (v1)\none'],
      truncated: false
    })
  for (const suffix of [
    '',
    '?projectId=%20',
    '?projectId=a&projectId=b',
    '?projectId=a&actor=human'
  ]) {
    assert.equal((await call('laptop', '/worker-guidance' + suffix)).status, 400)
  }
  for (const type of ['agent', 'commander']) {
    const { token } = await call('laptop', '/delegations', { type, id: 'worker', projectId })
    assert.equal((await query(token)).status, 403)
    assert.equal((await call(token, '/handoffs-index')).status, 403)
  }
})
