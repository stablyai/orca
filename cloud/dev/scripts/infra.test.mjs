import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const script = 'dev/scripts/infra.mjs'

// IAC_TOOL=echo prints the argv the real binary would have received, so the root a flag selects
// is observable without running Terraform.
function invoke(args) {
  return execFileSync('node', [script, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, IAC_TOOL: 'echo' }
  }).trim()
}

function rejects(args) {
  try {
    execFileSync('node', [script, ...args], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, IAC_TOOL: 'echo' }
    })
  } catch (error) {
    return error.stderr
  }
  throw new Error(`expected ${args.join(' ')} to exit non-zero`)
}

// Why: 9 relay workflows, the fence broker, and the three infra:* package scripts all invoke this
// without --root. If the default ever moves off infra/terraform they break silently at the plan.
test('omitting --root keeps every existing caller on the relay root', () => {
  for (const environment of ['staging', 'production']) {
    assert.equal(
      invoke(['init', '--env', environment]),
      `-chdir=infra/terraform init -backend-config=backend/${environment}.hcl`
    )
    assert.equal(
      invoke(['plan', '--env', environment]),
      `-chdir=infra/terraform plan -var-file=environments/${environment}.tfvars -out=${environment}.tfplan`
    )
  }
})

// Only the relay root ships here; the foundation and apps roots stay in the private repository.
test('each root name selects exactly its own directory', () => {
  const directories = { relay: 'infra/terraform' }
  for (const [root, directory] of Object.entries(directories)) {
    for (const environment of ['staging', 'production']) {
      assert.equal(
        invoke(['init', '--env', environment, '--root', root]),
        `-chdir=${directory} init -backend-config=backend/${environment}.hcl`
      )
    }
  }
})

test('an unknown root fails closed rather than falling back to the relay root', () => {
  const stderr = rejects(['plan', '--env', 'staging', '--root', 'releay'])
  assert.match(stderr, /Unknown --root/)
  assert.doesNotMatch(stderr, /infra\/terraform /)
})

test('a missing environment still fails before any root is resolved', () => {
  assert.match(rejects(['plan']), /Missing --env/)
})

// Why: the guard refuses a staging apply while the relay data plane is asleep. Applying it to the
// app or foundation roots would block work that never touches that data plane.
test('the sleeping staging relay guard is scoped to the relay root', () => {
  const source = readFileSync(new URL('./infra.mjs', import.meta.url), 'utf8')
  assert.match(source, /environment === 'staging' && root === 'relay'/)
})
