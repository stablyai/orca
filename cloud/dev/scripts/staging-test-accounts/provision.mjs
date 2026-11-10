// Creates (or repairs) the two staging test accounts and their test team in the PropelAuth test
// env behind auth-staging.onorca.dev, and records them in the accounts file (0600, outside git).
// Idempotent: existing users keep their password unless --reset-passwords is given or the file has
// none. Prints emails, ids and statuses only.
//
//   node cloud/dev/scripts/staging-test-accounts/provision.mjs [--reset-passwords]
//
// Needs gcloud access to onorca-cloud-staging (reads the propelauth-api-key secret).
import { randomBytes } from 'node:crypto'
import { ACCOUNTS_FILE, LABELS, propelAuth, readAccounts, writeAccounts } from './common.mjs'

const DEFAULT_EMAILS = {
  OWNER: 'neil+orca-stg-owner@stably.ai',
  MEMBER: 'neil+orca-stg-member@stably.ai'
}
const TEAM_NAME = 'Orca Staging Eval Team'

const resetPasswords = process.argv.includes('--reset-passwords')
const values = readAccounts()

function newPassword() {
  // PropelAuth wants mixed classes; base64url plus a fixed suffix satisfies every policy.
  return `${randomBytes(18).toString('base64url')}Aa1!`
}

async function ensureUser(label) {
  const email = values[`STAGING_${label}_EMAIL`] ?? DEFAULT_EMAILS[label]
  values[`STAGING_${label}_EMAIL`] = email
  const found = await propelAuth(
    'GET',
    `/api/backend/v1/user/email?email=${encodeURIComponent(email)}&include_orgs=true`
  )
  let userId
  if (found.status === 200) {
    userId = found.body.user_id
  } else if (found.status === 404) {
    const password = newPassword()
    const created = await propelAuth('POST', '/api/backend/v1/user/', {
      email,
      email_confirmed: true,
      send_email_to_confirm_email_address: false,
      password
    })
    if (created.status !== 200) throw new Error(`${label}: create user ${created.status}`)
    userId = created.body.user_id
    values[`STAGING_${label}_PASSWORD`] = password
    console.log(`${label}: created ${email}`)
  } else {
    throw new Error(`${label}: user lookup ${found.status}`)
  }
  values[`STAGING_${label}_PROPELAUTH_USER_ID`] = userId
  if (resetPasswords || !values[`STAGING_${label}_PASSWORD`]) {
    const password = newPassword()
    const set = await propelAuth('PUT', `/api/backend/v1/user/${userId}/password`, {
      password,
      ask_user_to_update_password_on_login: false
    })
    if (set.status !== 200) throw new Error(`${label}: set password ${set.status}`)
    values[`STAGING_${label}_PASSWORD`] = password
    console.log(`${label}: password set`)
  }
  // Persist after every step so a later failure never loses a password that is already live.
  writeAccounts(values)
  return { userId, orgs: found.status === 200 ? (found.body.org_id_to_org_info ?? {}) : {} }
}

async function ensureTeam(owner, member) {
  let orgId = values.STAGING_ORG_PROPELAUTH_ID
  if (orgId) {
    const existing = await propelAuth('GET', `/api/backend/v1/org/${orgId}`)
    if (existing.status !== 200) orgId = undefined
  }
  if (!orgId) {
    orgId = Object.values(owner.orgs).find((org) => org.org_name === TEAM_NAME)?.org_id
  }
  if (!orgId) {
    const created = await propelAuth('POST', '/api/backend/v1/org/', { name: TEAM_NAME })
    if (created.status !== 200) throw new Error(`create team ${created.status}`)
    orgId = created.body.org_id
    console.log(`team: created ${TEAM_NAME}`)
  }
  values.STAGING_ORG_PROPELAUTH_ID = orgId
  writeAccounts(values)
  for (const [label, user, role] of [
    ['OWNER', owner, 'Owner'],
    ['MEMBER', member, 'Member']
  ]) {
    if (user.orgs[orgId]) continue
    const added = await propelAuth('POST', '/api/backend/v1/org/add_user', {
      org_id: orgId,
      user_id: user.userId,
      role
    })
    if (added.status !== 200) throw new Error(`team: add ${label} ${added.status}`)
    console.log(`team: added ${label} as ${role}`)
  }
}

const users = {}
for (const label of LABELS) users[label] = await ensureUser(label)
await ensureTeam(users.OWNER, users.MEMBER)
console.log(`ok: accounts in ${ACCOUNTS_FILE}`)
console.log(
  'next: node cloud/dev/scripts/staging-test-accounts/signin.mjs OWNER --print-ids (and MEMBER) ' +
    'to read the Orca user/org ids for the staging billing/sandbox allow-list'
)
