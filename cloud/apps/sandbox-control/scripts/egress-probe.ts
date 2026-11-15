// Release probe for sandbox egress, against DEV only, through Orca's own paths: real dev workspaces
// created with a dev-JWK user token, driven from a terminal over the `orca` CLI's pairing code (the
// desktop's E2EE path). Bogus tokens only; httpbin.org plays the model provider.
//   pnpm --filter @orca-cloud/sandbox-control exec tsx scripts/egress-probe.ts [--keep]
//
// A throwaway identity gets: the dev GitHub App installation bound for one test repo (operator), a
// stored GitHub identity (the dev member-github route, so member placeholders exist), and bogus
// personal secrets ANTHROPIC_API_KEY (base URL: the echo host) and OPENAI_API_KEY (base URL:
// chatgpt.com, so its egress takes the ChatGPT relay). Two workspaces:
//   public  a public repo the App is not installed on: member placeholder, no App token (#758)
//   app     the App-installed test repo: App token, github.com fail-closed
// Checks (every one names the host it is about):
//   - api.anthropic-compatible echo host: the provider sees the bogus key where the VM sent the
//     placeholder, the other auth header unchanged, nothing from Vercel's hop; a foreign key 403s.
//   - chatgpt.com: the placeholder reaches ChatGPT (any provider answer; not the firewall's 403 and
//     not Cloudflare's edge page); a foreign bearer 403s.
//   - api.github.com: no credential 403s; with the workspace placeholder GitHub answers 200.
//   - github.com: anonymous `git ls-remote` works on `public` (#758) and 403s on `app`; the
//     workspace's own git (placeholder extraheader) works on `app`.
//   - the VM holds placeholders, never the bogus values.
//
// Inputs (files, never printed):
//   ORCA_PROBE_DEV_JWK_FILE        dev test signing key (SM: orca-sandbox-control-dev-test-jwk)
//   ORCA_PROBE_OPERATOR_TOKEN_FILE dev operator token (SM: orca-sandbox-control-dev-operator-token)
//   ORCA_PROBE_CONTROL_URL         default: the dev sandbox-control Worker (anything else is refused)
//   ORCA_PROBE_CLI                 default: the installed Orca app's `orca` CLI
// Prints one JSON report; exits 1 on any failed expectation. See scripts/README.md.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SignJWT, importJWK, type JWK } from 'jose'
import { judge, latencyByClass, parseRunnerOutput, runnerCommand, sha8, type ProbeCase } from './egress-probe-checks'

const CONTROL_URL = process.env.ORCA_PROBE_CONTROL_URL ?? 'https://orca-sandbox-control-dev.lovecast.workers.dev'
const ORCA_CLI = process.env.ORCA_PROBE_CLI ?? '/Applications/Orca.app/Contents/Resources/bin/orca'
/** The dev GitHub App is installed on this repo. */
const APP_REPO = process.env.ORCA_PROBE_APP_REPO ?? 'https://github.com/nwparker/orca-sandbox-push-test'
/** Public, and the dev App is not installed on its owner. */
const PUBLIC_REPO = 'https://github.com/octocat/Hello-World'
/** The model provider stand-in (ANTHROPIC_BASE_URL): echoes headers, streams, takes bodies up to ~1 MB. */
const ECHO = 'https://httpbin.org'
/** A WebSocket echo: COPILOT_PROVIDER_BASE_URL points here, so it carries a credential claim. */
const WS_ECHO = 'https://ws.postman-echo.com'
/** A host no credential is for: a placeholder sent here must arrive unswapped. */
const OTHER_ECHO = 'https://postman-echo.com'
type Mode = 'proxy' | 'firewall'

if (!/^https:\/\/[a-z0-9-]+-dev\.lovecast\.workers\.dev$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(CONTROL_URL)) {
  throw new Error(`refusing a non-dev control plane: ${CONTROL_URL}`)
}

const keep = process.argv.includes('--keep')
const modeArg = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'default'
/** `default`: the environment's EGRESS_SWAP_MODE, unchanged. Otherwise each mode in turn, set per sandbox. */
const MODES: readonly (Mode | 'default')[] = modeArg === 'both' ? ['proxy', 'firewall'] : modeArg === 'proxy' || modeArg === 'firewall' ? [modeArg] : ['default']
const runId = randomBytes(4).toString('hex')
const sub = `egress-probe-${runId}`
const accountId = `dev:${sub}`
const fileSecret = (env: string): string => {
  const file = process.env[env]
  if (!file) {
    throw new Error(`set ${env}`)
  }
  return readFileSync(file, 'utf8').trim()
}

async function userToken(): Promise<string> {
  const jwk = JSON.parse(fileSecret('ORCA_PROBE_DEV_JWK_FILE')) as { kid: string; private: JWK; issuers?: { sandbox?: string }; audiences?: { sandbox?: string } }
  return new SignJWT({ sub, purpose: 'sandbox' })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(jwk.issuers?.sandbox ?? 'orca-sandbox-dev-test')
    .setAudience(jwk.audiences?.sandbox ?? 'orca-sandbox')
    .setIssuedAt()
    .setExpirationTime('45m')
    .sign(await importJWK(jwk.private, 'ES256'))
}

type Reply = { status: number; body: Record<string, any> | null }

function client(bearer: string) {
  return async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const response = await fetch(`${CONTROL_URL}${path}`, {
      method,
      // clone-progress: the desktop's create, whose clone runs after ready (GET /v1/sandboxes/:id/clone).
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-orca-sandbox-features': 'clone-progress' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(300_000)
    })
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null }
  }
}

/** The shipped CLI over a workspace's pairing code; the code never reaches logs or the report. */
function orca(pairingCode: string, args: string[], timeoutMs = 60_000): Promise<any> {
  return new Promise((resolve) => {
    execFile(ORCA_CLI, [...args, '--json', '--pairing-code', pairingCode], { timeout: timeoutMs, maxBuffer: 8 << 20, env: { ...process.env, ORCA_PAIRING_CODE: '' } }, (_error, stdout) => {
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

/** Every string in a CLI result, one per line (terminal output may come as a string, lines or chunks). */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join('\n')
  return ''
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs one line in a fresh workspace terminal and returns the output once `PRB-END` shows. */
async function inTerminal(pairingCode: string, projectRoot: string, line: string): Promise<string> {
  // A project whose clone failed is not a git repo: register it as a folder then (the checks still run).
  const repo = await orca(pairingCode, ['repo', 'add', '--path', projectRoot, '--kind', 'git'])
  if (!repo?.ok) {
    await orca(pairingCode, ['repo', 'add', '--path', projectRoot, '--kind', 'folder'])
  }
  let handle: string | undefined
  for (let attempt = 0; attempt < 3 && !handle; attempt++) {
    const created = await orca(pairingCode, ['terminal', 'create', '--worktree', `path:${projectRoot}`, '--title', 'egress-probe'])
    handle = created?.result?.terminal?.handle ?? created?.result?.handle ?? created?.result?.terminal?.id
    if (!handle) await sleep(2_000)
  }
  if (!handle) {
    throw new Error('could not open a workspace terminal')
  }
  // `clear` first: the read must only see this run's lines.
  await orca(pairingCode, ['terminal', 'send', '--terminal', handle, '--text', `clear; ${line}`, '--enter'])
  // Generous: in a mode with hangs every request may take its full 30 s client timeout.
  const deadline = Date.now() + 900_000
  while (Date.now() < deadline) {
    const read = await orca(pairingCode, ['terminal', 'read', '--terminal', handle])
    const text = textOf(read?.result)
    // The typed line is base64 past its first words, so PRB-END only shows once the runner prints it.
    if (text.includes('PRB-END')) {
      return text
    }
    await sleep(1500)
  }
  throw new Error('the probe did not finish in the workspace terminal')
}

/** Git and env facts, one short line each, then the HTTP cases. */
function factsScript(gitChecks: Record<string, string>, bogus: Record<string, string>): string {
  const lines = Object.entries(gitChecks).map(([name, command]) => `GIT_TERMINAL_PROMPT=0 timeout 60 ${command} >/dev/null 2>&1; echo "PRB ${name} rc=$?"`)
  // The VM must hold placeholders: compare by sha256 so the bogus values never cross the terminal.
  for (const [name, digest] of Object.entries(bogus)) {
    // The verdict word is a variable: the typed command (echoed by the terminal) must not contain it.
    lines.push(`v=placeholder; [ "$(printf %s "\${${name}:-}" | sha256sum | cut -c1-8)" = ${digest} ] && v=bogus; echo "PRB env.${name} holds=$v"`)
  }
  return lines.join('; ')
}

async function main(): Promise<void> {
  const failures: string[] = []
  const report: Record<string, unknown> = { runId, modes: MODES }
  const cleanup: (() => Promise<unknown>)[] = []
  const started = Date.now()
  console.error(`[egress-probe] run ${runId}: throwaway identity ${sub}, modes ${MODES.join(', ')}`)
  const user = client(await userToken())
  const operator = client(fileSecret('ORCA_PROBE_OPERATOR_TOKEN_FILE'))
  const bogus = {
    ANTHROPIC_API_KEY: `sk-ant-api03-orcaprobe${randomBytes(16).toString('hex')}`,
    OPENAI_API_KEY: `sk-proj-orcaprobe${randomBytes(16).toString('hex')}`,
    COPILOT_PROVIDER_API_KEY: `orcaprobe-${randomBytes(16).toString('hex')}`
  }
  const results: Record<string, unknown>[] = []
  const check = (mode: string, workspace: string, name: string, ok: boolean, detail: string) => {
    results.push({ mode, workspace, check: name, ok })
    if (!ok) {
      failures.push(`[${mode}/${workspace}] ${name}: ${detail}`)
    }
  }
  try {
    // Identity: the App bound for the test repo, and a stored GitHub identity (member placeholders).
    const bound = await operator('POST', '/v1/internal/github/bindings', { repoUrl: APP_REPO, accountId })
    const installationId: number | undefined = bound.body?.bound?.installationId
    if (bound.status !== 200 || !installationId) {
      throw new Error(`bind the dev App: ${bound.status} ${bound.body?.error ?? ''}`)
    }
    cleanup.push(() => operator('DELETE', '/v1/internal/github/bindings', { installationId, accountId }))
    const member = await operator('POST', '/v1/internal/dev/member-github', { accountId, userId: sub, repoUrl: APP_REPO, login: 'egress-probe', githubUserId: 1, name: 'egress probe' })
    if (member.status !== 200) {
      throw new Error(`store the probe's GitHub identity: ${member.status} ${member.body?.error ?? ''}`)
    }
    for (const [name, value] of [
      ['ANTHROPIC_API_KEY', bogus.ANTHROPIC_API_KEY],
      ['ANTHROPIC_BASE_URL', ECHO],
      ['OPENAI_API_KEY', bogus.OPENAI_API_KEY],
      ['OPENAI_BASE_URL', 'https://chatgpt.com/backend-api/codex'],
      ['COPILOT_PROVIDER_API_KEY', bogus.COPILOT_PROVIDER_API_KEY],
      ['COPILOT_PROVIDER_BASE_URL', WS_ECHO]
    ] as const) {
      const put = await user('PUT', `/v1/secrets/personal/${name}`, { value })
      cleanup.push(() => user('DELETE', `/v1/secrets/personal/${name}`))
      if (put.status !== 200) {
        throw new Error(`PUT secret ${name}: ${put.status} ${put.body?.error ?? ''}`)
      }
    }
    const clones: Record<string, string> = {}
    const create = async (label: string, repo: string) => {
      console.error(`[egress-probe] creating the ${label} workspace (${sub}-${label})`)
      const reply = await user('POST', '/v1/sandboxes', { workspaceId: `${sub}-${label}`, machineSize: 'standard', repo: { url: repo }, useEnvironment: false })
      const id: string | undefined = reply.body?.sandbox?.id
      if (id) {
        cleanup.unshift(() => user('DELETE', `/v1/sandboxes/${id}`))
      }
      if (reply.status !== 200 || !reply.body?.connection?.pairingCode) {
        throw new Error(`create the ${label} workspace: ${reply.status} ${reply.body?.error ?? ''}`)
      }
      console.error(`[egress-probe] ${label} workspace ${id}`)
      // The desktop's path: the clone runs after ready, and the desktop polls it.
      let clone = 'unknown'
      for (const until = Date.now() + 240_000; Date.now() < until; await sleep(3_000)) {
        clone = String((await user('GET', `/v1/sandboxes/${id}/clone`)).body?.clone?.state ?? 'unknown')
        if (clone.startsWith('done') || clone.startsWith('failed')) break
      }
      clones[label] = clone
      return { id: id!, pairingCode: reply.body.connection.pairingCode as string, projectRoot: reply.body.connection.projectRoot as string }
    }
    const [publicBox, appBox] = await Promise.all([create('public', PUBLIC_REPO), create('app', APP_REPO)])
    report.workspaces = { public: publicBox.id, app: appBox.id }
    for (const [workspace, state] of Object.entries(clones)) {
      check('create', workspace, 'github.com: the workspace repo clones (desktop create)', state === 'done', `clone ${state}`)
    }

    // Header values the runner reads from env (`$NAME`): the Bearer forms, and git's own header.
    const prelude = [
      'export PROBE_OPENAI_BEARER="Bearer $OPENAI_API_KEY" PROBE_COPILOT_BEARER="Bearer $COPILOT_PROVIDER_API_KEY" PROBE_GH_BEARER="Bearer $GH_TOKEN"',
      'PROBE_GIT_AUTH="$(git config --global --get-all http.https://github.com/.extraheader | tail -n 1)"; export PROBE_GIT_AUTH="${PROBE_GIT_AUTH#Authorization: }"'
    ].join('; ')
    const publicCases: ProbeCase[] = [
      {
        name: 'custom base URL (model key): placeholder swapped, other auth untouched',
        url: `${ECHO}/anything`,
        method: 'POST',
        headers: { 'x-api-key': '$ANTHROPIC_API_KEY', authorization: 'Bearer probe-keep-bearer' },
        expect: { kind: 'swapped', headers: { 'x-api-key': bogus.ANTHROPIC_API_KEY }, keep: ['authorization'] },
        repeat: 5,
        latency: 'model_key'
      },
      { name: 'custom base URL: foreign key fails closed', url: `${ECHO}/anything`, method: 'POST', headers: { 'x-api-key': 'sk-ant-probe-foreign' }, expect: { kind: 'denied' } },
      { name: 'custom base URL: chunked stream (SSE framing) through the swap', url: `${ECHO}/stream/5`, headers: { 'x-api-key': '$ANTHROPIC_API_KEY' }, stream: true, expect: { kind: 'streamed', minChunks: 1 }, latency: 'model_key_stream' },
      {
        // 1 MB: the public echo hosts refuse larger bodies themselves (httpbin 413 at 2 MB, postman-echo 500 at 1 MB).
        name: 'custom base URL: 1 MB upload through the swap',
        url: `${ECHO}/anything`,
        method: 'POST',
        uploadBytes: 1 << 20,
        headers: { 'x-api-key': '$ANTHROPIC_API_KEY', 'content-type': 'application/octet-stream' },
        expect: { kind: 'swapped', headers: { 'x-api-key': bogus.ANTHROPIC_API_KEY } },
        latency: 'upload_1mb'
      },
      { name: 'chatgpt.com: placeholder reaches ChatGPT', url: 'https://chatgpt.com/backend-api/codex/models', headers: { authorization: '$PROBE_OPENAI_BEARER' }, expect: { kind: 'upstream' }, repeat: 5, latency: 'codex' },
      { name: 'chatgpt.com: foreign bearer fails closed', url: 'https://chatgpt.com/backend-api/codex/models', headers: { authorization: 'Bearer probe-foreign' }, expect: { kind: 'denied' } },
      { name: 'WebSocket upgrade through the swap', url: `${WS_ECHO}/raw`, headers: { authorization: '$PROBE_COPILOT_BEARER' }, websocket: true, expect: { kind: 'upgraded' }, latency: 'websocket' },
      { name: 'WebSocket host: no credential fails closed', url: `${WS_ECHO}/raw`, websocket: true, expect: { kind: 'denied' } },
      { name: 'a placeholder sent to another host arrives unswapped', url: `${OTHER_ECHO}/get`, headers: { 'x-api-key': '$ANTHROPIC_API_KEY' }, expect: { kind: 'unswapped', headers: ['x-api-key'] } },
      { name: 'api.github.com: no credential fails closed', url: 'https://api.github.com/rate_limit', expect: { kind: 'denied' } }
    ]
    const appCases: ProbeCase[] = [
      { name: 'api.github.com: workspace placeholder swapped (GitHub answers)', url: 'https://api.github.com/rate_limit', headers: { authorization: '$PROBE_GH_BEARER' }, expect: { kind: 'upstream' }, repeat: 5, latency: 'github_api' },
      { name: 'github.com: git smart-HTTP with the workspace header', url: `${APP_REPO}.git/info/refs?service=git-upload-pack`, headers: { authorization: '$PROBE_GIT_AUTH' }, expect: { kind: 'upstream' }, repeat: 5, latency: 'git_http' },
      {
        name: 'github.com: LFS batch API with the workspace header',
        url: `${APP_REPO}.git/info/lfs/objects/batch`,
        method: 'POST',
        headers: { authorization: '$PROBE_GIT_AUTH', accept: 'application/vnd.git-lfs+json', 'content-type': 'application/vnd.git-lfs+json' },
        expect: { kind: 'upstream' },
        latency: 'git_lfs'
      },
      { name: 'github.com: anonymous fails closed with an App token', url: `${APP_REPO}.git/info/refs?service=git-upload-pack`, expect: { kind: 'denied' } }
    ]
    const digests = Object.fromEntries(Object.entries(bogus).map(([name, value]) => [name, sha8(value)]))
    const latency: Record<string, unknown> = {}
    for (const mode of MODES) {
      if (mode !== 'default') {
        for (const box of [publicBox, appBox]) {
          const set = await operator('POST', `/v1/internal/sandboxes/${box.id}/egress-mode`, { mode })
          if (set.status !== 200) {
            throw new Error(`set egress mode ${mode} on ${box.id}: ${set.status} ${set.body?.error ?? ''} (is EGRESS_SWAP_MODE (A2) on dev?)`)
          }
        }
      }
      console.error(`[egress-probe] mode ${mode}: running the checks in both workspaces`)
      const branch = `egress-probe-${runId}-${mode}`
      const runs = await Promise.all([
        inTerminal(publicBox.pairingCode, publicBox.projectRoot, `${prelude}; ${factsScript({ 'git.public-anonymous': `git ls-remote ${PUBLIC_REPO} HEAD` }, digests)}; ${runnerCommand(publicCases)}`),
        inTerminal(
          appBox.pairingCode,
          appBox.projectRoot,
          `${prelude}; ${factsScript(
            {
              'git.app-anonymous': `git -c http.extraheader= -c http.https://github.com/.extraheader= ls-remote ${APP_REPO} HEAD`,
              'git.app-fetch': 'git fetch -q origin',
              'git.app-push': `git push -q origin HEAD:refs/heads/${branch}`,
              'git.app-push-delete': `git push -q origin --delete ${branch}`
            },
            {}
          )}; ${runnerCommand(appCases)}`
        )
      ])
      for (const [workspace, text, cases] of [['public', runs[0], publicCases], ['app', runs[1], appCases]] as const) {
        const summaries = parseRunnerOutput(text, cases.length)
        cases.forEach((probeCase, i) => {
          const problems = judge(probeCase, summaries[i]!)
          check(mode, workspace, probeCase.name, problems.length === 0, problems.join('; '))
        })
        latency[`${mode}/${workspace}`] = latencyByClass(cases, summaries)
      }
      const rc = (text: string, name: string) => new RegExp(`PRB ${name.replaceAll('.', '\\.')} rc=(\\d+)`).exec(text)?.[1]
      check(mode, 'public', 'github.com: anonymous git ls-remote of a public repo works (#758)', rc(runs[0], 'git.public-anonymous') === '0', `rc=${rc(runs[0], 'git.public-anonymous')}`)
      check(mode, 'app', 'github.com: anonymous git ls-remote is refused with an App token', !['0', undefined].includes(rc(runs[1], 'git.app-anonymous')), `rc=${rc(runs[1], 'git.app-anonymous')}`)
      for (const step of ['fetch', 'push', 'push-delete']) {
        check(mode, 'app', `github.com: git ${step} through the workspace's own header`, rc(runs[1], `git.app-${step}`) === '0', `rc=${rc(runs[1], `git.app-${step}`)}`)
      }
      for (const name of Object.keys(digests)) {
        check(mode, 'public', `the VM holds a placeholder for ${name}`, new RegExp(`PRB env\\.${name} holds=placeholder`).test(runs[0]), 'the VM env holds the bogus value itself')
      }
    }
    report.checks = results
    report.latency = latency
  } catch (error) {
    failures.push(`probe error: ${error instanceof Error ? error.message : String(error)}`)
    report.checks = results
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
