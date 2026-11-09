// Live check that the staging Team roster lists pending invites past PropelAuth's 100-per-page
// limit and can revoke one that sits past page 1 (orca-cloud #700). Creates a throwaway team as the
// OWNER test account, invites N example.com addresses (undeliverable by design), reads the roster
// through auth-staging, revokes a page-2 invite, re-reads, then deletes the team. Prints counts and
// statuses only.
//
//   node cloud/dev/scripts/staging-test-accounts/invite-paging-check.mjs [N=105]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { account, orcaAuth, propelAuth } from './common.mjs'

const N = Number(process.argv[2] ?? 105)
if (!Number.isInteger(N) || N <= 100 || N > 300) throw new Error('N must be 101..300')
const here = dirname(fileURLToPath(import.meta.url))
const tag = Date.now().toString(36)
const teamName = `Invite Paging Check ${tag}`
const inviteEmail = (index) => `orca-invite-check+${tag}-${index}@example.com`

const dir = mkdtempSync(join(tmpdir(), 'orca-stg-'))
const sessionFile = join(dir, 'owner.json')
let providerOrgId
let failed = false
function check(name, ok, detail = '') {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

try {
  execFileSync('node', [join(here, 'signin.mjs'), 'OWNER', '--session-out', sessionFile], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
  const { accessToken } = JSON.parse(readFileSync(sessionFile, 'utf8'))

  const created = await orcaAuth(accessToken, 'POST', '/v1/desktop/orgs', { name: teamName })
  if (created.status !== 200) throw new Error(`create team ${created.status}`)
  const orgId = created.body.orgId

  const owner = await propelAuth(
    'GET',
    `/api/backend/v1/user/email?email=${encodeURIComponent(account('OWNER').email)}&include_orgs=true`
  )
  providerOrgId = Object.values(owner.body?.org_id_to_org_info ?? {}).find(
    (org) => org.org_name === teamName
  )?.org_id
  if (!providerOrgId) throw new Error('throwaway team not found in PropelAuth')

  // Seed through the backend API: the desktop route is rate limited per actor and org.
  let invited = 0
  for (let start = 1; start <= N; start += 10) {
    const batch = []
    for (let index = start; index < Math.min(start + 10, N + 1); index++) {
      batch.push(
        propelAuth('POST', '/api/backend/v1/invite_user', {
          org_id: providerOrgId,
          email: inviteEmail(index),
          role: 'Member'
        })
      )
    }
    for (const result of await Promise.all(batch)) if (result.status === 200) invited++
  }
  check(`seeded ${N} invites`, invited === N, `${invited} accepted`)

  const page2 = await propelAuth(
    'GET',
    `/api/backend/v1/pending_org_invites?org_id=${providerOrgId}&page_size=100&page_number=1`
  )
  const target = page2.body?.invites?.[0]?.invitee_email
  check('provider has a second page', Boolean(target), `page 2 rows ${page2.body?.invites?.length}`)

  const before = await orcaAuth(accessToken, 'GET', `/v1/desktop/orgs/${orgId}/members`)
  const listed = before.body?.pendingInvites ?? []
  check('roster read', before.status === 200, `status ${before.status}`)
  check(
    `roster lists all ${N} pending invites`,
    listed.length === N && !before.body?.pendingInvitesUnavailable,
    `listed ${listed.length}`
  )
  check('roster includes the page-2 invite', listed.some((invite) => invite.email === target))

  const revoked = await orcaAuth(accessToken, 'POST', `/v1/desktop/orgs/${orgId}/invites/revoke`, {
    email: target
  })
  check('revoke a page-2 invite', revoked.status >= 200 && revoked.status < 300, `${revoked.status}`)

  const after = await orcaAuth(accessToken, 'GET', `/v1/desktop/orgs/${orgId}/members`)
  const remaining = after.body?.pendingInvites ?? []
  check(
    `roster shows ${N - 1} after revoke`,
    remaining.length === N - 1 && !remaining.some((invite) => invite.email === target),
    `listed ${remaining.length}`
  )
} catch (error) {
  failed = true
  console.log(`FAIL ${error instanceof Error ? error.message : 'error'}`)
} finally {
  if (providerOrgId) {
    const removed = await propelAuth('DELETE', `/api/backend/v1/org/${providerOrgId}`)
    console.log(`cleanup: delete throwaway team ${removed.status}`)
  }
  rmSync(dir, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
