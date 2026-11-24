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
    if (req.headers.authorization !== 'Bearer fixture') {
      res.writeHead(401)
      res.end()
      return
    }
    res.end(JSON.stringify({ cloud: { userId: 'acct' } }))
  })
  const authUrl = await listen(auth)
  t.after(() => auth.close())
  const gateway = createMemoryServer({ capabilitiesEndpoint: authUrl, databasePath: ':memory:' })
  const url = `${await listen(gateway)}/v1/commander/memory`
  t.after(() => gateway.close())
  async function post(path, body) {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal(res.status, 200)
    return res.json()
  }
  await post('/human', {
    pageId: 'review',
    title: 'Review',
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
  await writeFile(file, JSON.stringify({ ...grant, url, projectId, type: 'agent' }), {
    mode: 0o600
  })
  const server = new McpServer({ name: 'memory', version: '1' })
  registerCommanderMemoryTools(server, file)
  const client = new Client({ name: 'worker', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(left), server.connect(right)])
  t.after(() => client.close())
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
  const index = await call('commander_resume_context')
  assert.equal(index.total, 1)
  assert.deepEqual(
    index.handoffs.map((item) => [item.pageId, item.goal, item.version]),
    [[saved.pageId, 'Recover CI work', 1]]
  )
  assert.equal(JSON.stringify(index).includes('Checked tests'), false)
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
    const askFromMislabeledGrant = { ...grant, url, type: 'agent', projectId: 'github:org/other' }
    await writeFile(file, JSON.stringify(askFromMislabeledGrant))
    const wrongFile = await client.callTool({ name: 'commander_ask_preference', arguments: ask })
    assert.equal(wrongFile.isError, true)
    assert.match(wrongFile.content[0].text, /does not match this memory grant/)
    const denied = await client.callTool({
      name: 'commander_ask_preference',
      arguments: { ...ask, projectId: 'github:org/other' }
    })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /HTTP 403/)
    await writeFile(file, JSON.stringify({ ...grant, url, type: 'agent', projectId }))
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
})
