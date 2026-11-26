import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMemoryServer } from '../cloud/apps/commander-memory/server.mjs'
import { validHandoffContent } from '../cloud/apps/commander-memory/handoff-content.mjs'
import { encodeHandoffBody, readHandoff } from '../src/shared/commander/handoff-content.ts'
import { registerCommanderMemoryTools } from './commander-memory-tools.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

test('a fresh agent reads human guidance and records only its own project decisions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-mcp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = createServer((req, res) => {
    const bearer = req.headers.authorization
    if (bearer !== 'Bearer fixture' && bearer !== 'Bearer other-org') {
      res.writeHead(401)
      res.end()
      return
    }
    res.end(
      JSON.stringify({
        cloud: { userId: 'acct', activeOrgId: bearer === 'Bearer fixture' ? null : 'org-b' }
      })
    )
  })
  const authUrl = await listen(auth)
  t.after(() => auth.close())
  const gateway = createMemoryServer({ capabilitiesEndpoint: authUrl, databasePath: ':memory:' })
  const url = `${await listen(gateway)}/v1/commander/memory`
  t.after(() => gateway.close())
  async function post(path, body, bearer = 'fixture') {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal(res.status, 200)
    return res.json()
  }
  await post('/human', {
    pageId: 'review',
    title: 'Recurring answer',
    kind: 'guideline',
    body: 'Review release notes',
    expectedVersion: 0,
    requestId: 'r1'
  })
  await post('/human', {
    pageId: 'private',
    title: 'Private',
    kind: 'guideline',
    projectId: 'github:org/private',
    body: 'Private guideline',
    expectedVersion: 0,
    requestId: 'r2'
  })
  const projectId = 'github:org/api'
  const grant = await post('/delegations', { projectId, type: 'agent', id: 'claude' })
  const file = join(dir, 'grant.json')
  async function exportGrant(current, id) {
    await writeFile(
      file,
      JSON.stringify({ ...current, url, projectId: id, actorId: 'claude', type: 'agent' }),
      { mode: 0o600 }
    )
  }
  await exportGrant(grant, projectId)
  async function connect() {
    const server = new McpServer({ name: 'memory', version: '1' })
    await registerCommanderMemoryTools(server, file)
    const worker = new Client({ name: 'worker', version: '1' })
    const [left, right] = InMemoryTransport.createLinkedPair()
    await Promise.all([worker.connect(left), server.connect(right)])
    t.after(() => worker.close())
    return worker
  }
  const client = await connect()
  async function call(name, args = {}) {
    const value = await client.callTool({ name, arguments: args })
    assert.ok(!value.isError, value.content[0].text)
    return JSON.parse(value.content[0].text)
  }
  assert.deepEqual(
    (await call('commander_guidelines')).map((p) => p.pageId),
    ['review']
  )
  const { page } = await call('commander_save_memory', {
    pageId: 'protocol',
    kind: 'decision',
    title: 'Protocol',
    body: 'Use v2',
    expectedVersion: 0,
    requestId: 'decision',
    links: ['review']
  })
  assert.deepEqual(page.actor, { type: 'agent', id: 'claude' })
  assert.equal(page.projectId, projectId)
  assert.deepEqual(
    (await call('commander_recall', { pageId: 'protocol' })).history.map((p) => p.body),
    ['Use v2']
  )
  assert.equal((await call('commander_recall', { query: 'Protocol' })).total, 1)
  for (let version = 1; version < 27; version++) {
    await call('commander_save_memory', {
      pageId: 'protocol',
      expectedVersion: version,
      requestId: `update-${version}`,
      kind: 'decision',
      title: 'Protocol',
      body: `Release ${version + 1}`
    })
  }
  const first = await call('commander_recall', { pageId: 'protocol' })
  assert.equal(first.page.version, 27)
  assert.equal(first.history.length, 25)
  assert.equal(first.nextBeforeVersion, 3)

  const removal = await call('commander_remove_memory', {
    pageId: 'protocol',
    expectedVersion: 27,
    requestId: 'remove1'
  })
  assert.equal(removal.page.deleted, true)
  assert.equal((await call('commander_recall', { query: 'Protocol' })).total, 0)
  const older = await call('commander_recall', {
    pageId: 'protocol',
    beforeVersion: first.nextBeforeVersion
  })
  assert.equal(older.page.deleted, true)
  assert.deepEqual(
    older.history.map((p) => [p.version, p.body]),
    [
      [2, 'Release 2'],
      [1, 'Use v2']
    ]
  )
  assert.equal(older.nextBeforeVersion, null)
  assert.deepEqual(
    (await call('commander_recall')).pages.map((p) => p.pageId),
    ['review']
  )
  const saved = {
    kind: 'note',
    pageId: 'handoff-632cab2d-6e11-4ce4-8acc-e671a05f5762',
    requestId: 'save-handoff',
    expectedVersion: 0,
    projectId,
    title: 'Recover CI work',
    body: '## Progress\n\nChecked tests\n\n## Next step\n\nReview the branch'
  }
  await post('/human', saved)
  await post('/human', {
    ...saved,
    requestId: 'other-project',
    pageId: 'handoff-468b5460-f504-4316-9090-3e4cdeca99bb',
    projectId: 'github:org/private'
  })
  const requested = []
  const capture = (req) => requested.push(req.url)
  gateway.on('request', capture)
  const index = await call('commander_resume_context', { limit: 1 })
  assert.deepEqual(await call('commander_resume_context', { offset: 1, limit: 1 }), {
    handoffs: [],
    total: 1
  })
  gateway.off('request', capture)
  assert.deepEqual(requested, [
    '/v1/commander/memory/agent/handoffs?offset=0&limit=1',
    '/v1/commander/memory/agent/handoffs?offset=1&limit=1'
  ])
  assert.equal(index.total, 1)
  assert.deepEqual(
    index.handoffs.map((item) => [item.pageId, item.goal, item.version]),
    [[saved.pageId, 'Recover CI work', 1]]
  )
  assert.equal(JSON.stringify(index).includes('Checked tests'), false)
  await t.test('older services can list handoffs and access failures stay visible', async (t) => {
    let status = 404
    const serviceFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', (input, init) => {
      if (new URL(input).pathname.endsWith('/agent/handoffs')) {
        return Promise.resolve(new Response(null, { status }))
      }
      return serviceFetch(input, init)
    })
    assert.deepEqual(await call('commander_resume_context', { limit: 1 }), index)
    assert.deepEqual(await call('commander_resume_context', { offset: 1, limit: 1 }), {
      handoffs: [],
      total: 1
    })
    status = 403
    const denied = await client.callTool({ name: 'commander_resume_context', arguments: {} })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /HTTP 403/)
  })
  const resumed = await call('commander_resume_context', { pageId: saved.pageId })
  assert.equal(resumed.progress, 'Checked tests')
  assert.equal(resumed.nextStep, 'Review the branch')
  await post('/human', {
    pageId: saved.pageId,
    expectedVersion: 1,
    requestId: 'retire',
    deleted: true
  })
  assert.equal((await call('commander_resume_context')).total, 0)
  assert.equal(
    (
      await client.callTool({
        name: 'commander_resume_context',
        arguments: { pageId: saved.pageId }
      })
    ).isError,
    true
  )

  await t.test('exact owner preferences return one recorded decision per occurrence', async () => {
    const question = 'Which Node version should release builds use?'
    const rule = {
      pageId: 'node-policy',
      title: 'Recurring answer',
      kind: 'guideline',
      projectId,
      body: JSON.stringify({ version: 1, question, answer: 'Node 24' }),
      expectedVersion: 0,
      requestId: 'create-node-policy'
    }
    await post('/human', { ...rule, pageId: 'other-repo-rule', projectId: 'github:org/other' })
    assert.deepEqual(
      await call('commander_ask_preference', { projectId, question, requestId: 'lookup1' }),
      {
        matched: false,
        reason: 'disabled'
      }
    )
    await post('/preferences/settings', { enabled: true, expectedVersion: 0 })
    assert.deepEqual(
      await call('commander_ask_preference', { projectId, question, requestId: 'lookup1' }),
      {
        matched: false,
        reason: 'missing'
      }
    )
    await post('/human', { ...rule, requestId: 'create-api-policy' })
    const ask = { projectId, question: `  ${question}  `, requestId: 'release-node-version' }
    const answer = await call('commander_ask_preference', ask)
    assert.deepEqual(answer, {
      matched: true,
      answer: 'Node 24',
      rulePageId: 'node-policy',
      ruleVersion: 1,
      decisionPageId: answer.decisionPageId
    })
    await post('/preferences/settings', { enabled: false, expectedVersion: 1 })
    assert.deepEqual(await call('commander_ask_preference', ask), {
      matched: false,
      reason: 'disabled'
    })
    await post('/preferences/settings', { enabled: true, expectedVersion: 2 })
    const retry = await call('commander_ask_preference', ask)
    assert.deepEqual(retry, answer)
    const denied = await client.callTool({
      name: 'commander_ask_preference',
      arguments: { ...ask, projectId: 'github:org/other' }
    })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /does not match this memory grant/)
    const { page, history } = await call('commander_recall', { pageId: answer.decisionPageId })
    assert.equal(page.kind, 'decision')
    assert.equal(page.projectId, projectId)
    assert.equal(history.length, 1)
    assert.deepEqual(
      (await call('commander_guidelines')).map((p) => p.pageId),
      ['review']
    )
    assert.equal((await call('commander_recall', { pageId: 'node-policy' })).page.body, rule.body)
    await post('/human', {
      ...rule,
      pageId: 'node-policy-2',
      requestId: 'other-answer',
      body: JSON.stringify({ version: 1, question, answer: 'Node 22' })
    })
    assert.deepEqual(
      await call('commander_ask_preference', { projectId, question, requestId: 'lookup2' }),
      {
        matched: false,
        reason: 'conflict'
      }
    )
    for (const args of [
      { question },
      { requestId: 'blank', question: '   ' },
      { requestId: 'long', question: 'a'.repeat(501) },
      { requestId: 'bad id', question }
    ]) {
      assert.equal(
        (
          await client.callTool({
            name: 'commander_ask_preference',
            arguments: { projectId, ...args }
          })
        ).isError,
        true
      )
    }
  })

  await t.test(
    'a pending write and recall keep their startup project across file renewal',
    async () => {
      const otherId = 'github:org/other'
      const otherGrant = await post('/delegations', {
        projectId: otherId,
        type: 'agent',
        id: 'claude'
      })
      const pending = {
        pageId: 'checkpoint',
        kind: 'note',
        title: 'Checkpoint',
        body: 'Built locally',
        expectedVersion: 0,
        requestId: 'first-checkpoint'
      }
      await exportGrant(otherGrant, otherId)
      for (const [name, args] of [
        ['commander_save_memory', pending],
        ['commander_recall', {}]
      ]) {
        const response = await client.callTool({ name, arguments: args })
        assert.equal(response.isError, true)
        assert.match(response.content[0].text, /original project/)
      }
      // Even a mislabeled file must satisfy the service's independent write check.
      await exportGrant(otherGrant, projectId)
      const denied = await client.callTool({ name: 'commander_save_memory', arguments: pending })
      assert.equal(denied.isError, true)
      assert.match(denied.content[0].text, /HTTP 403/)
      const otherTenant = await post(
        '/delegations',
        { projectId, type: 'agent', id: 'claude' },
        'other-org'
      )
      await exportGrant(otherTenant, projectId)
      for (const [name, args] of [
        ['commander_save_memory', pending],
        ['commander_recall', {}]
      ]) {
        const response = await client.callTool({ name, arguments: args })
        assert.equal(response.isError, true)
        assert.match(response.content[0].text, /original Orca account and organization/)
      }
      const renewed = await post('/delegations', { projectId, type: 'agent', id: 'claude' })
      await exportGrant(renewed, projectId)
      assert.equal((await call('commander_save_memory', pending)).page.projectId, projectId)
    }
  )

  await t.test('a legacy grant requires restart before adopting a replacement token', async () => {
    await exportGrant({ token: grant.token, expiresAt: grant.expiresAt }, projectId)
    const legacyClient = await connect()
    const read = { name: 'commander_recall', arguments: { pageId: 'review' } }
    assert.ok(!(await legacyClient.callTool(read)).isError)
    const renewed = await post('/delegations', { projectId, type: 'agent', id: 'claude' })
    await exportGrant(renewed, projectId)
    const rejected = await legacyClient.callTool(read)
    assert.equal(rejected.isError, true)
    assert.match(rejected.content[0].text, /Restart the client with the renewed grant/)
    const restartedClient = await connect()
    assert.ok(!(await restartedClient.callTool(read)).isError)
  })

  await t.test(
    'a multibyte body at the byte limit saves and an extra byte fails locally',
    async () => {
      const body = `${'界'.repeat(21845)}a`
      const note = {
        body,
        kind: 'note',
        pageId: 'byte-limit',
        requestId: 'boundary',
        title: 'Boundary',
        expectedVersion: 0
      }
      assert.equal((await call('commander_save_memory', note)).page.body, body)
      const tooLarge = await client.callTool({
        name: 'commander_save_memory',
        arguments: { ...note, body: `${body}a`, requestId: 'over', expectedVersion: 1 }
      })
      assert.equal(tooLarge.isError, true)
      assert.match(tooLarge.content[0].text, /65,536 UTF-8 bytes/)
      assert.equal((await call('commander_recall', { pageId: note.pageId })).page.version, 1)
    }
  )
})

test('the cloud picker and agent accept the same Markdown sections at the decoded length limit', () => {
  const page = {
    pageId: 'handoff-3feadb88-3068-4fc1-b494-1c82ab35816f',
    kind: 'note',
    title: 'Resume a release',
    deleted: false
  }
  const boundary = '## Next step\n'.padEnd(4000, 'x')
  for (const [progress, nextStep, valid] of [
    ['', '', true],
    ['Progress\n\n## Next step\n\ncontinued', '\\## Next step', true],
    [boundary, boundary, true],
    [`${boundary}x`, '', false],
    ['', `${boundary}x`, false]
  ]) {
    const candidate = { ...page, body: encodeHandoffBody({ progress, nextStep }) }
    assert.equal(validHandoffContent(candidate), valid)
    assert.deepEqual(
      readHandoff(candidate),
      valid ? { goal: page.title, progress, nextStep } : null
    )
  }
})
