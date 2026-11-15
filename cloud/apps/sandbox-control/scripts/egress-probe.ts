// Release probe for sandbox egress, against DEV only. Bogus tokens and our own echo server; no real
// credential is sent anywhere.
//   pnpm --filter @orca-cloud/sandbox-control exec tsx scripts/egress-probe.ts [--firewall-only] [--keep]
//
// 1. Firewall: a throwaway VM gets the policy egressPolicy() compiles for a workspace with a Codex
//    account, an Anthropic key, a member's GitHub identity and (then without) the repo's App token.
//    Its forward rules point at an echo sandbox instead of the egress proxy. From that VM: each
//    placeholder must be forwarded for the right host with every other auth header unchanged;
//    foreign or missing credentials on a credential host must get the firewall's own 403
//    (fail-closed); anonymous git to a public repo must work when there is no App token (#758).
//    Hosts: chatgpt.com, api.anthropic.com, github.com, api.github.com.
// 2. Swap (unless --firewall-only): a real dev workspace with a bogus ANTHROPIC_API_KEY whose
//    ANTHROPIC_BASE_URL is the echo sandbox. The echo (as the "provider") must see the bogus key in
//    place of the placeholder, the other auth header unchanged, and nothing from Vercel's hop.
//    An unclaimed request to that host must be refused.
//
// Inputs (read from files or env, never printed):
//   VERCEL_TOKEN or ORCA_PROBE_VERCEL_TOKEN_FILE   Vercel token for the dev team
//   ORCA_PROBE_DEV_JWK_FILE                        dev test signing key (swap layer only)
//   ORCA_PROBE_CONTROL_URL                         default: the dev sandbox-control Worker
//   ORCA_PROBE_VERCEL_TEAM_ID / _PROJECT_ID        default: Orca's dev team and project
// Prints one JSON report and exits 1 on any failed expectation. See scripts/README.md.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SignJWT, importJWK, type JWK } from 'jose'
import { accountProvider } from '../src/account-providers'
import { memberPlaceholder } from '../src/github-user-tokens'
import { egressPolicy, githubPlaceholderToken, type LifecycleDeps } from '../src/lifecycle'
import { gitBasicAuthorization } from '../src/network-policy'
import { secretPlaceholder } from '../src/secret-egress'
import type { SandboxRow } from '../src/store'
import { createVercelSandboxApi } from '../src/vercel-sandbox-api'
import { ECHO_SERVER, judge, parseProbeOutput, probeScript, type ProbeCase } from './egress-probe-checks'

const CONTROL_URL = process.env.ORCA_PROBE_CONTROL_URL ?? 'https://orca-sandbox-control-dev.lovecast.workers.dev'
const TEAM_ID = process.env.ORCA_PROBE_VERCEL_TEAM_ID ?? 'team_c5IO9DfEYAxKEUgMxrbEtO0a'
const PROJECT_ID = process.env.ORCA_PROBE_VERCEL_PROJECT_ID ?? 'prj_SkVtv6zJurF9dUHpfTRy4v9avwPq'
const IMAGE = 'vercel/sandbox/node:24'
const REGION = 'iad1'
const ECHO_PORT = 8080
/** A public repository: anonymous git must reach it when the workspace has no App token. */
const PUBLIC_REPO = 'https://github.com/octocat/Hello-World.git'

if (!/(-dev\.lovecast\.workers\.dev|127\.0\.0\.1|localhost)(\/|$)/.test(CONTROL_URL)) {
  throw new Error(`refusing a non-dev control plane: ${CONTROL_URL}`)
}

const args = process.argv.slice(2)
const firewallOnly = args.includes('--firewall-only')
const keep = args.includes('--keep')
const runId = randomBytes(4).toString('hex')

function secretFrom(envName: string, fileEnv: string): string | null {
  if (process.env[envName]) {
    return process.env[envName]!.trim()
  }
  const file = process.env[fileEnv]
  return file ? readFileSync(file, 'utf8').trim() : null
}

const vercelToken = secretFrom('VERCEL_TOKEN', 'ORCA_PROBE_VERCEL_TOKEN_FILE')
if (!vercelToken) {
  throw new Error('set VERCEL_TOKEN or ORCA_PROBE_VERCEL_TOKEN_FILE (dev team token)')
}
const vercel = createVercelSandboxApi({ token: vercelToken, teamId: TEAM_ID, projectId: PROJECT_ID })

type Box = { name: string; sessionId: string }

async function bootBox(role: string): Promise<Box> {
  const name = `orca-probe-${runId}-${role}`
  const state = await vercel.createBuildSandbox({ name, image: IMAGE, vcpus: 2, region: REGION, timeoutMs: 20 * 60_000, tags: { orcaEgressProbe: runId } })
  console.error(`[egress-probe] ${role} sandbox ${name}`)
  return { name, sessionId: state.session.id }
}

async function run(box: Box, script: string, env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return vercel.runCommand(box.sessionId, { command: 'bash', args: ['-c', script], env, timeoutMs: 120_000 })
}

/** The echo server on its public route: the probe's stand-in for the egress proxy and for a model provider. */
async function startEcho(box: Box): Promise<string> {
  const [route] = await vercel.updatePorts(box.name, [ECHO_PORT])
  if (!route) {
    throw new Error('echo sandbox got no route')
  }
  const started = await run(box, `setsid nohup node -e "$ECHO" ${ECHO_PORT} >/tmp/echo.log 2>&1 </dev/null & sleep 1; curl -s -m 5 http://127.0.0.1:${ECHO_PORT}/ready`, { ECHO: ECHO_SERVER })
  if (!started.stdout.includes('probeEcho')) {
    throw new Error(`echo server did not start: ${started.stderr.slice(-300)}`)
  }
  return route.url.replace(/\/+$/, '')
}

/** A workspace row with every credential route the firewall test needs (nothing is stored anywhere). */
function syntheticRow(id: string): SandboxRow {
  return {
    id,
    account_id: 'org:egress-probe',
    user_id: 'egress-probe',
    repo_url: PUBLIC_REPO.replace(/\.git$/, ''),
    egress_secret_hosts: [`ANTHROPIC_API_KEY@api.anthropic.com`, `account:codex:egress-probe@chatgpt.com`].join(','),
    egress_allow_hosts: null,
    egress_user_hosts: null
  } as SandboxRow
}

async function firewallLayer(probe: Box, echoUrl: string, failures: string[], report: Record<string, unknown>): Promise<void> {
  const row = syntheticRow(`probe${runId}`)
  const deps = { config: { egressProxyUrl: `${echoUrl}/egress/forward`, environment: 'dev', egressPreset: 'open' } } as unknown as LifecycleDeps
  const codex = accountProvider('codex')!
  const member = await memberPlaceholder(row.id, 'egress-probe-member')
  const env = {
    CODEX_PH: codex.format(codex.placeholder(row)),
    ANTHROPIC_PH: secretPlaceholder(row, 'ANTHROPIC_API_KEY'),
    GIT_PH: gitBasicAuthorization(githubPlaceholderToken(row)),
    GH_API_PH: `Bearer ${githubPlaceholderToken(row)}`,
    MEMBER_PH: gitBasicAuthorization(member)
  }
  const refs = `${PUBLIC_REPO}/info/refs?service=git-upload-pack`
  // Shared by both policies: model and account hosts.
  const modelCases: ProbeCase[] = [
    {
      name: 'chatgpt.com placeholder',
      url: 'https://chatgpt.com/backend-api/codex/models',
      headers: { authorization: '$CODEX_PH', 'chatgpt-account-id': 'probe-keep-account', 'x-api-key': 'probe-keep-other' },
      expect: { kind: 'forwarded', host: 'chatgpt.com', headers: { authorization: env.CODEX_PH, 'chatgpt-account-id': 'probe-keep-account', 'x-api-key': 'probe-keep-other' } }
    },
    { name: 'chatgpt.com foreign bearer', url: 'https://chatgpt.com/backend-api/codex/models', headers: { authorization: 'Bearer probe-foreign' }, expect: { kind: 'denied' } },
    { name: 'chatgpt.com no credential', url: 'https://chatgpt.com/backend-api/codex/models', expect: { kind: 'denied' } },
    {
      name: 'api.anthropic.com placeholder',
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'x-api-key': '$ANTHROPIC_PH', authorization: 'Bearer probe-keep-bearer' },
      expect: { kind: 'forwarded', host: 'api.anthropic.com', headers: { 'x-api-key': env.ANTHROPIC_PH, authorization: 'Bearer probe-keep-bearer' } }
    },
    { name: 'api.anthropic.com foreign key', url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: { 'x-api-key': 'sk-ant-probe-foreign' }, expect: { kind: 'denied' } },
    {
      name: 'api.github.com placeholder',
      url: 'https://api.github.com/rate_limit',
      headers: { authorization: '$GH_API_PH' },
      expect: { kind: 'forwarded', host: 'api.github.com', headers: { authorization: env.GH_API_PH } }
    },
    { name: 'api.github.com no credential', url: 'https://api.github.com/rate_limit', expect: { kind: 'denied' } }
  ]
  const policies: { name: string; gitToken?: string; cases: ProbeCase[]; anonymousGit: boolean }[] = [
    {
      name: 'with App token',
      gitToken: 'ghs_egress_probe_bogus',
      anonymousGit: false,
      cases: [
        ...modelCases,
        { name: 'github.com placeholder', url: refs, headers: { authorization: '$GIT_PH' }, expect: { kind: 'forwarded', host: 'github.com', headers: { authorization: env.GIT_PH } } },
        { name: 'github.com anonymous (fail-closed with a token)', url: refs, expect: { kind: 'denied' } }
      ]
    },
    {
      name: 'member identity, no App token (#758)',
      anonymousGit: true,
      cases: [
        ...modelCases,
        { name: 'github.com member placeholder', url: refs, headers: { authorization: '$MEMBER_PH' }, expect: { kind: 'forwarded', host: 'github.com', headers: { authorization: env.MEMBER_PH } } },
        { name: 'github.com anonymous', url: refs, expect: { kind: 'upstream', notDenied: true } }
      ]
    }
  ]
  const results: Record<string, unknown>[] = []
  for (const policy of policies) {
    await vercel.updateNetworkPolicy(probe.sessionId, egressPolicy(deps, row, policy.gitToken, [member]))
    const answers = parseProbeOutput((await run(probe, probeScript(policy.cases), env)).stdout)
    for (const probeCase of policy.cases) {
      const answer = answers.get(probeCase.name) ?? { status: 0, body: '' }
      const problems = judge(probeCase, answer)
      failures.push(...problems.map((problem) => `[${policy.name}] ${problem}`))
      results.push({ policy: policy.name, case: probeCase.name, status: answer.status, ok: problems.length === 0 })
    }
    // git itself, as the workspace doctor runs it.
    const git = await run(probe, `GIT_TERMINAL_PROMPT=0 timeout 60 git ls-remote ${PUBLIC_REPO} HEAD >/tmp/ls 2>/tmp/ls.err; echo "rc=$?"; grep -c . /tmp/ls; grep -o 'returned error: [0-9]*' /tmp/ls.err | head -1`)
    const ok = /rc=0/.test(git.stdout)
    if (ok !== policy.anonymousGit) {
      failures.push(`[${policy.name}] anonymous git ls-remote ${ok ? 'worked' : 'failed'} (${git.stdout.trim().replace(/\n/g, ' ')}), expected it to ${policy.anonymousGit ? 'work' : 'be refused'}`)
    }
    results.push({ policy: policy.name, case: 'git ls-remote (anonymous)', ok: ok === policy.anonymousGit, gitWorked: ok })
  }
  report.firewall = results
}

async function devToken(sub: string): Promise<string> {
  const file = process.env.ORCA_PROBE_DEV_JWK_FILE
  if (!file) {
    throw new Error('the swap layer needs ORCA_PROBE_DEV_JWK_FILE (or pass --firewall-only)')
  }
  const jwk = JSON.parse(readFileSync(file, 'utf8')) as { kid: string; private: JWK; issuers?: { sandbox?: string }; audiences?: { sandbox?: string } }
  return new SignJWT({ sub, purpose: 'sandbox' })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(jwk.issuers?.sandbox ?? 'orca-sandbox-dev-test')
    .setAudience(jwk.audiences?.sandbox ?? 'orca-sandbox')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(await importJWK(jwk.private, 'ES256'))
}

async function swapLayer(echoUrl: string, failures: string[], report: Record<string, unknown>, cleanup: (() => Promise<unknown>)[]): Promise<void> {
  const token = await devToken(`egress-probe-${runId}`)
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${CONTROL_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(150_000)
    })
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null }
  }
  // A key shape no provider issues: only the probe's echo ever sees it.
  const standIn = `sk-ant-api03-orcaprobe${randomBytes(16).toString('hex')}`
  for (const [name, value] of [['ANTHROPIC_API_KEY', standIn], ['ANTHROPIC_BASE_URL', echoUrl]] as const) {
    const put = await call('PUT', `/v1/secrets/personal/${name}`, { value })
    cleanup.push(() => call('DELETE', `/v1/secrets/personal/${name}`))
    if (put.status !== 200) {
      throw new Error(`PUT secret ${name}: ${put.status} ${put.body?.error ?? ''}`)
    }
  }
  const created = await call('POST', '/v1/sandboxes', { workspaceId: `egress-probe-${runId}`, machineSize: 'standard' })
  const sandboxId: string | undefined = created.body?.sandbox?.id
  if (sandboxId) {
    cleanup.unshift(() => call('DELETE', `/v1/sandboxes/${sandboxId}`))
  }
  const sessionId: string | undefined = created.body?.sandbox?.session?.id
  if (created.status !== 200 || !sessionId) {
    throw new Error(`create workspace: ${created.status} ${created.body?.error ?? ''}`)
  }
  console.error(`[egress-probe] dev workspace ${sandboxId}`)
  const box: Box = { name: '', sessionId }
  // The VM's env: orcad's, as an agent sees it.
  const envOf = `tr '\\0' '\\n' < /proc/$(cat ~/.orca-sandbox/orcad.pid)/environ | grep -E '^ANTHROPIC_(API_KEY|BASE_URL)=' | sed 's/^/export /'`
  const cases: ProbeCase[] = [
    {
      name: 'custom base URL, placeholder',
      url: `${echoUrl}/v1/messages`,
      method: 'POST',
      headers: { 'x-api-key': '$ANTHROPIC_API_KEY', authorization: 'Bearer probe-keep-bearer' },
      expect: { kind: 'swapped', headers: { 'x-api-key': standIn, authorization: 'Bearer probe-keep-bearer' } }
    },
    { name: 'custom base URL, foreign key', url: `${echoUrl}/v1/messages`, method: 'POST', headers: { 'x-api-key': 'sk-ant-probe-foreign' }, expect: { kind: 'denied' } }
  ]
  const result = await run(box, `eval "$(${envOf})"; [ "$ANTHROPIC_API_KEY" != "$STAND_IN_CHECK" ] && echo vm_holds_placeholder=1\n${probeScript(cases)}`, { STAND_IN_CHECK: standIn })
  if (!/^vm_holds_placeholder=1$/m.test(result.stdout)) {
    failures.push('[swap] the VM does not hold a placeholder for ANTHROPIC_API_KEY')
  }
  const answers = parseProbeOutput(result.stdout)
  const results = cases.map((probeCase) => {
    const answer = answers.get(probeCase.name) ?? { status: 0, body: '' }
    const problems = judge(probeCase, answer)
    failures.push(...problems.map((problem) => `[swap] ${problem}`))
    return { case: probeCase.name, status: answer.status, ok: problems.length === 0 }
  })
  report.swap = { sandboxId, results }
}

async function main(): Promise<void> {
  const failures: string[] = []
  const report: Record<string, unknown> = { runId }
  const cleanup: (() => Promise<unknown>)[] = []
  const started = Date.now()
  try {
    const [echoBox, probeBox] = await Promise.all([bootBox('echo'), bootBox('probe')])
    cleanup.push(() => vercel.deleteBuildSandbox(echoBox.name), () => vercel.deleteBuildSandbox(probeBox.name))
    const echoUrl = await startEcho(echoBox)
    await firewallLayer(probeBox, echoUrl, failures, report)
    if (!firewallOnly) {
      await swapLayer(echoUrl, failures, report, cleanup)
    }
  } catch (error) {
    failures.push(`probe error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (!keep) {
      for (const step of cleanup) {
        await step().catch((error: unknown) => console.error(`[egress-probe] cleanup: ${String(error)}`))
      }
    }
  }
  console.log(JSON.stringify({ ok: failures.length === 0, failures, ...report, ms: Date.now() - started }, null, 2))
  console.error(failures.length === 0 ? '[egress-probe] OK' : `[egress-probe] FAILED:\n  ${failures.join('\n  ')}`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

void main()
