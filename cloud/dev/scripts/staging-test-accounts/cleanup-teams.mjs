// Deletes throwaway teams that staging checks leave behind. STAGING (PropelAuth test env) ONLY.
// A team is deleted only when all of these hold:
//   - one of our test accounts (OWNER/MEMBER) is its Owner in PropelAuth,
//   - its name starts with a throwaway prefix (below or --prefix), or its Orca id was named
//     explicitly and its name still is not a kept team,
//   - it is not one of the kept teams (the allow-listed eval teams).
// Dry run by default; pass --yes to delete. Prints names, ids and statuses only.
//
//   node cleanup-teams.mjs                       # list what would go
//   node cleanup-teams.mjs --yes                 # delete every prefixed throwaway team
//   node cleanup-teams.mjs --yes org_<id> ...    # also delete these Orca teams (same rules)
//   node cleanup-teams.mjs --prefix "My Check " --yes
//
// Needs the accounts file (provision.mjs) and the PropelAuth key (gcloud, or the key file; see
// README). Run it after each check that creates teams.
import { LABELS, account, propelAuth } from './common.mjs'

const THROWAWAY_PREFIXES = ['W9 Acceptance ', 'Invite Paging Check ', 'Orca Check ']
// Allow-listed in staging billing/sandbox; never deleted, whatever the arguments say.
const KEPT_TEAMS = new Set(['Orca Staging Eval Team', 'Acme Eval 080424'])

const args = process.argv.slice(2)
const confirm = args.includes('--yes')
const prefixes = [...THROWAWAY_PREFIXES]
const orcaIds = []
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--yes') continue
  if (arg === '--prefix') {
    const value = args[++index]
    if (!value || value.trim().length < 4) throw new Error('--prefix needs at least 4 characters')
    prefixes.push(value)
  } else if (/^org_[0-9a-f-]{36}$/.test(arg)) {
    orcaIds.push(arg)
  } else {
    throw new Error(`unknown argument ${arg}`)
  }
}

// Orca ids map to PropelAuth orgs by name through the test accounts' own sessions.
const namesForOrcaIds = new Set()
if (orcaIds.length > 0) {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const signin = fileURLToPath(new URL('./signin.mjs', import.meta.url))
  const found = new Set()
  for (const label of LABELS) {
    const line = execFileSync('node', [signin, label, '--print-ids'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .at(-1)
    for (const org of JSON.parse(line).orgs ?? []) {
      if (orcaIds.includes(org.orgId)) {
        found.add(org.orgId)
        namesForOrcaIds.add(org.name)
      }
    }
  }
  for (const id of orcaIds) {
    if (!found.has(id)) console.log(`skip ${id}: not a team of our test accounts`)
  }
}

const candidates = new Map()
for (const label of LABELS) {
  const { email } = account(label)
  const user = await propelAuth(
    'GET',
    `/api/backend/v1/user/email?email=${encodeURIComponent(email)}&include_orgs=true`
  )
  if (user.status !== 200) throw new Error(`${label}: user lookup ${user.status}`)
  for (const org of Object.values(user.body.org_id_to_org_info ?? {})) {
    if (org.user_role !== 'Owner') continue
    const name = org.org_name
    if (KEPT_TEAMS.has(name)) continue
    if (prefixes.some((prefix) => name.startsWith(prefix)) || namesForOrcaIds.has(name)) {
      candidates.set(org.org_id, name)
    }
  }
}

if (candidates.size === 0) {
  console.log('nothing to clean up')
}
let failed = false
for (const [providerOrgId, name] of candidates) {
  if (!confirm) {
    console.log(`would delete: ${name}`)
    continue
  }
  const removed = await propelAuth('DELETE', `/api/backend/v1/org/${providerOrgId}`)
  if (removed.status !== 200) failed = true
  console.log(`delete ${name}: ${removed.status}`)
}
if (!confirm && candidates.size > 0) console.log('dry run; pass --yes to delete')
process.exitCode = failed ? 1 : 0
