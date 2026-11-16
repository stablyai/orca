// gh as the member: gh in the VM carries the sender's placeholder; on api.github.com the Worker signs with the
// member's own token only for REST under the workspace repo and for allowlisted mutations pinned to it.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { memberPlaceholder } from '../src/github-user-tokens'
import { NODE_REPOSITORY_QUERY } from '../src/github-graphql-pin'
import { memberMayAct } from '../src/member-git'
import { getSandbox } from '../src/store'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const ISSUER = 'https://oidc.vercel.com/team_orca'
const KEK = Buffer.alloc(32, 7).toString('base64')
const OP = 'o'.repeat(40)
const REPO = 'https://github.com/acme/app'
const MEMBER_TOKEN = 'ghs_member_stand_in_for_app'
const APP = 'Bearer ghs_app_installation'

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
  const upstream: { url: string; authorization: string | null }[] = []
  const nodes: Record<string, string> = { PR_in: 'R_app', PR_out: 'R_other', IC_in: 'R_app' }
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL, SECRETS_KEK: KEK, OPERATOR_TOKEN: OP },
    {
      egressKeysForIssuer: () => createLocalJWKSet(jwks),
      credentials: { authorizationFor: async () => APP },
      github: {
        tokenForRepo: async (url: string) => ({ token: `ghs_member_stand_in_for_${url.split('/').at(-1)}`, expiresAt: h.now() + 3_600_000 }),
        installationForRepo: async () => null
      } as never,
      egressFetch: async (input, init) => {
        const url = String(input)
        const authorization = new Headers(init?.headers).get('authorization')
        if (url === 'https://api.github.com/repos/acme/app' && authorization === APP) {
          return Response.json({ node_id: 'R_app' })
        }
        if (url === 'https://api.github.com/graphql' && authorization === APP && typeof init?.body === 'string') {
          const body = JSON.parse(String(init?.body)) as { query: string; variables?: { id?: string } }
          if (body.query === NODE_REPOSITORY_QUERY) {
            const repo = nodes[body.variables?.id ?? '']
            return Response.json({ data: { node: repo ? { __typename: 'PullRequest', repository: { id: repo } } : null } })
          }
        }
        upstream.push({ url, authorization })
        return new Response('{}', { status: 200 })
      }
    }
  )
  const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
  const created = await h.call('POST', '/v1/sandboxes', { bearer: alice, body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: REPO } } })
  const id: string = created.body.sandbox.id
  await h.call('POST', '/v1/internal/dev/member-github', {
    bearer: OP,
    body: { accountId: 'org:acme', userId: 'alice', repoUrl: REPO, login: 'alice-gh', githubUserId: 11, name: 'alice' }
  })
  const placeholder = await memberPlaceholder(id, 'alice')
  async function api(path: string, method: string, body?: unknown, authorization = `token ${placeholder}`) {
    const oidc = await new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${id}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer(ISSUER)
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const response = await h.send(
      new Request(`${PROXY_URL}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          'vercel-forwarded-host': 'api.github.com',
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': path,
          'vercel-sandbox-oidc-token': oidc,
          authorization
        }
      })
    )
    return { status: response.status, body: await response.text() }
  }
  return { h, id, api, upstream }
}

const createPr = (repositoryId: string) => ({
  query: 'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }',
  variables: { input: { repositoryId, baseRefName: 'main', headRefName: 'f', title: 't' } }
})

describe('gh as the member on api.github.com', () => {
  it('gh pr create in the workspace repo goes out as the member', async () => {
    const t = await setup()
    expect((await t.api('/graphql', 'POST', createPr('R_app'))).status).toBe(200)
    expect(t.upstream.at(-1)).toEqual({ url: 'https://api.github.com/graphql', authorization: `Bearer ${MEMBER_TOKEN}` })
  })

  it('a comment or update on a PR of this repo is the member; one of another repo is refused, never sent', async () => {
    const t = await setup()
    await t.api('/graphql', 'POST', { query: 'mutation { addComment(input: { subjectId: "PR_in", body: "x" }) { clientMutationId } }' })
    expect(t.upstream.at(-1)!.authorization).toBe(`Bearer ${MEMBER_TOKEN}`)
    const before = t.upstream.length
    const refused = await t.api('/graphql', 'POST', { query: 'mutation { updatePullRequest(input: { pullRequestId: "PR_out" }) { clientMutationId } }' })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body).errors[0].message).toContain("this workspace's repository")
    expect(t.upstream.length).toBe(before)
    expect((await t.api('/graphql', 'POST', createPr('R_other'))).status).toBe(403)
  })

  it('queries, other mutations and REST outside the repo stay on the installation token; REST in the repo is the member', async () => {
    const t = await setup()
    expect((await t.api('/graphql', 'POST', { query: 'query { viewer { login } }' })).status).toBe(200)
    expect(t.upstream.at(-1)!.authorization).toBe(APP)
    await t.api('/graphql', 'POST', { query: 'mutation { addLabelsToLabelable(input: { labelableId: "PR_in", labelIds: ["L"] }) { clientMutationId } }' })
    expect(t.upstream.at(-1)!.authorization).toBe(APP)
    await t.api('/user', 'GET')
    expect(t.upstream.at(-1)!.authorization).toBe(APP)
    await t.api('/repos/acme/app/pulls', 'GET')
    expect(t.upstream.at(-1)!.authorization).toBe(`Bearer ${MEMBER_TOKEN}`)
  })
})

const grantBob = (t: Awaited<ReturnType<typeof setup>>) =>
  t.h.raw.prepare(`INSERT INTO workspace_grants (id, sandbox_id, account_id, user_id, device_kind, device_label, status, created_at) VALUES ('g9', ?, 'org:acme', 'bob', 'desktop', 'Bob', 'active', 1)`).run(t.id)
const sentBy = (t: Awaited<ReturnType<typeof setup>>, user: string, at: number) =>
  t.h.raw
    .prepare('INSERT INTO workspace_member_sends (sandbox_id, user_id, sent_at) VALUES (?, ?, ?) ON CONFLICT (sandbox_id, user_id) DO UPDATE SET sent_at = excluded.sent_at')
    .run(t.id, user, at)
const MERGE = { query: 'mutation { mergePullRequest(input: { pullRequestId: "PR_in" }) { clientMutationId } }' }
const COMMENT = { query: 'mutation { addComment(input: { subjectId: "PR_in", body: "x" }) { clientMutationId } }' }

describe('no approval leaves a workspace; merges are the owner’s', () => {
  it('an approval through the owner’s gh is refused (403, never sent); comments and other reviews are the owner', async () => {
    const t = await setup()
    const before = t.upstream.length
    for (const body of [
      { query: 'mutation { addPullRequestReview(input: { pullRequestId: "PR_in", event: APPROVE }) { clientMutationId } }' },
      { query: 'mutation { submitPullRequestReview(input: { pullRequestReviewId: "PRR_in", event: APPROVE }) { clientMutationId } }' },
      {
        query: 'mutation R($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }',
        variables: { input: { pullRequestId: 'PR_in', event: 'approve' } }
      }
    ]) {
      const refused = await t.api('/graphql', 'POST', body)
      expect(refused.status).toBe(403)
      expect(JSON.parse(refused.body).errors[0].message).toContain('Approvals have to be done by a person on GitHub')
    }
    for (const event of ['APPROVE', 'approve', 'Approve']) {
      expect((await t.api('/repos/acme/app/pulls/7/reviews', 'POST', { event })).status).toBe(403)
      expect((await t.api('/repos/acme/app/pulls/7/reviews/3/events', 'POST', { event })).status).toBe(403)
    }
    const rest = await t.api('/repos/acme/app/Pulls/7/Reviews/', 'POST', { event: 'APPROVE' })
    expect([rest.status, JSON.parse(rest.body).message]).toEqual([403, expect.stringContaining('person on GitHub')])
    // Nothing of those reached GitHub.
    expect(t.upstream.length).toBe(before)
    await t.api('/repos/acme/app/pulls/7/reviews', 'POST', { event: 'REQUEST_CHANGES', body: 'x' })
    expect(t.upstream.at(-1)!.authorization).toBe(`Bearer ${MEMBER_TOKEN}`)
    await t.api('/repos/acme/app/pulls/7/reviews', 'POST', { event: 'COMMENT', body: 'I approve of the idea' })
    expect(t.upstream.at(-1)!.authorization).toBe(`Bearer ${MEMBER_TOKEN}`)
    await t.api('/graphql', 'POST', { query: 'mutation { addPullRequestReview(input: { pullRequestId: "PR_in", event: REQUEST_CHANGES, body: "x" }) { clientMutationId } }' })
    expect(t.upstream.at(-1)!.authorization).toBe(`Bearer ${MEMBER_TOKEN}`)
  })

  it('the workspace’s own App placeholder can’t approve either; other App calls go out as before', async () => {
    const t = await setup()
    const before = t.upstream.length
    const app = (path: string, body: unknown) => t.api(path, 'POST', body, `Bearer orca-ph-${t.id}`)
    expect((await app('/repos/acme/app/pulls/7/reviews', { event: 'APPROVE' })).status).toBe(403)
    expect((await app('/graphql', { query: 'mutation { addPullRequestReview(input: { pullRequestId: "PR_x", event: APPROVE }) { clientMutationId } }' })).status).toBe(403)
    expect(t.upstream.length).toBe(before)
    // An escaped path or a dismissal is refused too.
    expect((await app('/repos/acme/app/pulls/7/%72eviews', { event: 'APPROVE' })).status).toBe(403)
    expect((await t.api('/repos/acme/app/pulls/7/reviews/3/dismissals', 'PUT', { message: 'x' }, `Bearer orca-ph-${t.id}`)).status).toBe(403)
    expect((await t.api('/repos/acme/app/pulls/7/%72eviews', 'POST', { event: 'APPROVE' })).status).toBe(403)
    expect(t.upstream.length).toBe(before)
    expect((await app('/repos/acme/app/issues/7/comments', { body: 'x' })).status).toBe(200)
    expect(t.upstream.at(-1)!.authorization).toBe(APP)
    expect((await app('/repos/acme/app/pulls/7/reviews', { event: 'COMMENT', body: 'x' })).status).toBe(200)
    expect(t.upstream.at(-1)!.authorization).toBe(APP)
  })

  it('merges (GraphQL, PR merge, branch merge) are the owner’s; a stray grant or send changes nothing', async () => {
    const t = await setup()
    const mergeAll = async () => {
      const seen: (string | null)[] = []
      await t.api('/graphql', 'POST', MERGE)
      seen.push(t.upstream.at(-1)!.authorization)
      await t.api('/repos/acme/app/pulls/7/merge', 'PUT', {})
      seen.push(t.upstream.at(-1)!.authorization)
      await t.api('/repos/acme/app/merges', 'POST', { base: 'main', head: 'f' })
      seen.push(t.upstream.at(-1)!.authorization)
      return seen
    }
    expect(await mergeAll()).toEqual(Array(3).fill(`Bearer ${MEMBER_TOKEN}`))
    // Leftovers from before sharing was removed: a teammate grant row and their later send.
    grantBob(t)
    sentBy(t, 'bob', t.h.now())
    expect(await mergeAll()).toEqual(Array(3).fill(`Bearer ${MEMBER_TOKEN}`))
    await t.api('/graphql', 'POST', COMMENT)
    expect(t.upstream.at(-1)!.authorization).toBe(`Bearer ${MEMBER_TOKEN}`)
  })
})

describe('memberMayAct (identity rule)', () => {
  it('the owner always acts, with no send and no expiry; no one else ever does', async () => {
    const t = await setup()
    const row = (await getSandbox(t.h.env.SANDBOX_DB, t.id))!
    expect(memberMayAct(row, 'alice')).toBe(true)
    expect(memberMayAct(row, 'bob')).toBe(false)
    grantBob(t)
    sentBy(t, 'bob', t.h.now())
    expect(memberMayAct(row, 'alice')).toBe(true)
    expect(memberMayAct(row, 'bob')).toBe(false)
  })
})
