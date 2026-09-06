import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configureEnvironments } from './configure-environments.mjs'

const env = {
  GH_TOKEN: 'test-token',
  SIGNING_GATE_APP_ID: '123',
  SIGNING_REHEARSAL_BRANCH: 'signing-test'
}
test('creates four protected environments with isolated branches and no admin bypass', async () => {
  const calls = []
  await configureEnvironments(env, async (url, init) => {
    calls.push({ url, ...init })
    if (init.method !== 'GET') {
      return Response.json({})
    }
    if (url.includes('/deployment-branch-policies')) {
      return Response.json({ branch_policies: [], total_count: 0 })
    }
    if (url.endsWith('/deployment_protection_rules')) {
      return Response.json({ custom_deployment_protection_rules: [] })
    }
    return new Response('', { status: 404 })
  })
  const puts = calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 4)
  for (const put of puts) {
    assert.equal(JSON.parse(put.body).can_admins_bypass, false)
  }
  const branchPosts = calls.filter(
    (c) => c.method === 'POST' && c.url.endsWith('/deployment-branch-policies')
  )
  assert.deepEqual(
    branchPosts.map((c) => JSON.parse(c.body).name),
    ['main', 'main', 'signing-test', 'signing-test']
  )
  assert.equal(
    calls.filter((c) => c.method === 'POST' && JSON.parse(c.body).integration_id === 123).length,
    4
  )
  for (const call of calls) {
    assert.equal(call.redirect, 'error')
  }
})
test('refuses to overwrite existing reviewer protection', async () => {
  await assert.rejects(
    configureEnvironments(env, async () =>
      Response.json({ protection_rules: [{ type: 'required_reviewers' }] })
    ),
    /Refusing to replace/
  )
})
test('validates credentials before making mutations', async () => {
  await assert.rejects(
    configureEnvironments({}, async () => {
      throw new Error('Unexpected network call')
    }),
    /required/
  )
})
test('refuses an unexpected existing branch policy', async () => {
  await assert.rejects(
    configureEnvironments(env, async (url) =>
      Response.json(
        url.includes('/deployment-branch-policies')
          ? { branch_policies: [{ name: '*', type: 'branch' }], total_count: 1 }
          : {}
      )
    ),
    /Unexpected existing branch/
  )
})
