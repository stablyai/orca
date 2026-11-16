// Dev soak: a running workspace keeps working across GitHub App installation-token rotations.
// One throwaway identity, one App-installed workspace. In the VM a loop runs `git ls-remote origin` and an
// api.github.com call with the workspace placeholder every 30 s. The control plane must rotate the 1 h token
// in the live policy with no failed call. Renews the lease like a desktop. Deletes everything at the end.
//   ORCA_PROBE_DEV_JWK_FILE=... ORCA_PROBE_OPERATOR_TOKEN_FILE=... tsx scripts/egress-refresh-soak.ts [minutes]
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SignJWT, importJWK, type JWK } from 'jose'

const CONTROL_URL = 'https://orca-sandbox-control-dev.lovecast.workers.dev'
const ORCA_CLI = process.env.ORCA_PROBE_CLI ?? '/Applications/Orca.app/Contents/Resources/bin/orca'
const APP_REPO = 'https://github.com/nwparker/orca-sandbox-push-test'
const minutes = Number(process.argv[2] ?? 75)
const runId = randomBytes(4).toString('hex')
const sub = `egress-soak-${runId}`
const accountId = `dev:${sub}`
const secret = (env: string) => readFileSync(process.env[env]!, 'utf8').trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (line: string) => console.error(`[soak ${new Date().toISOString()}] ${line}`)

async function userToken(): Promise<string> {
  const jwk = JSON.parse(secret('ORCA_PROBE_DEV_JWK_FILE')) as { kid: string; private: JWK; issuers?: { sandbox?: string }; audiences?: { sandbox?: string } }
  return new SignJWT({ sub, purpose: 'sandbox' })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(jwk.issuers?.sandbox ?? 'orca-sandbox-dev-test')
    .setAudience(jwk.audiences?.sandbox ?? 'orca-sandbox')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(await importJWK(jwk.private, 'ES256'))
}

async function call(bearer: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer ?? (await userToken())}`, 'content-type': 'application/json', 'x-orca-sandbox-features': 'clone-progress' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000)
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null }
}

function orca(pairingCode: string, args: string[]): Promise<any> {
  return new Promise((resolve) => {
    execFile(ORCA_CLI, [...args, '--json', '--pairing-code', pairingCode], { timeout: 60_000, maxBuffer: 8 << 20, env: { ...process.env, ORCA_PAIRING_CODE: '' } }, (_e, stdout) => {
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}
const textOf = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map(textOf).join('\n') : v && typeof v === 'object' ? Object.values(v).map(textOf).join('\n') : ''

async function main() {
  const operator = secret('ORCA_PROBE_OPERATOR_TOKEN_FILE')
  const cleanup: (() => Promise<unknown>)[] = []
  let failed = false
  try {
    const bound = await call(operator, 'POST', '/v1/internal/github/bindings', { repoUrl: APP_REPO, accountId })
    const installationId = bound.body?.bound?.installationId
    if (!installationId) throw new Error(`bind: ${bound.status}`)
    cleanup.push(() => call(operator, 'DELETE', '/v1/internal/github/bindings', { installationId, accountId }))
    const created = await call(null, 'POST', '/v1/sandboxes', { workspaceId: `${sub}-app`, machineSize: 'standard', repo: { url: APP_REPO }, useEnvironment: false })
    const id: string = created.body?.sandbox?.id
    if (id) cleanup.unshift(() => call(null, 'DELETE', `/v1/sandboxes/${id}`))
    if (created.status !== 200) throw new Error(`create: ${created.status} ${created.body?.error ?? ''}`)
    log(`workspace ${id} (sub ${sub})`)
    for (const until = Date.now() + 240_000; Date.now() < until; await sleep(3000)) {
      const clone = String((await call(null, 'GET', `/v1/sandboxes/${id}/clone`)).body?.clone?.state ?? '')
      if (clone.startsWith('done') || clone.startsWith('failed')) {
        log(`clone ${clone}`)
        break
      }
    }
    const { pairingCode, projectRoot } = created.body!.connection as { pairingCode: string; projectRoot: string }
    await orca(pairingCode, ['repo', 'add', '--path', projectRoot, '--kind', 'git'])
    const term = await orca(pairingCode, ['terminal', 'create', '--worktree', `path:${projectRoot}`, '--title', 'soak'])
    const handle: string = term?.result?.terminal?.handle ?? term?.result?.handle ?? term?.result?.terminal?.id
    // One line per 30 s: epoch, git rc, api.github.com status. Placeholders only; nothing secret is printed.
    const loop = `nohup bash -c 'while :; do t=$(date +%s); git ls-remote origin HEAD >/dev/null 2>&1; g=$?; a=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/nwparker/orca-sandbox-push-test); echo "$t git=$g api=$a" >> /tmp/soak.log; sleep 30; done' >/dev/null 2>&1 &`
    await orca(pairingCode, ['terminal', 'send', '--terminal', handle, '--text', loop, '--enter'])
    const end = Date.now() + minutes * 60_000
    while (Date.now() < end) {
      await sleep(5 * 60_000)
      const lease = await call(null, 'POST', `/v1/sandboxes/${id}/lease`, { extendMs: 30 * 60_000 })
      log(`lease ${lease.status} status=${lease.body?.sandbox?.status}`)
    }
    await orca(pairingCode, ['terminal', 'send', '--terminal', handle, '--text', 'clear; echo SOAK-BEGIN; awk \'{print}\' /tmp/soak.log | tr "\\n" " "; echo; echo SOAK-END', '--enter'])
    await sleep(4000)
    const text = textOf((await orca(pairingCode, ['terminal', 'read', '--terminal', handle]))?.result)
    const body = text.slice(text.lastIndexOf('SOAK-BEGIN') + 10, text.lastIndexOf('SOAK-END'))
    const samples = [...body.matchAll(/(\d{10}) git=(\d+) api=(\d{3})/g)].map((m) => ({ t: Number(m[1]), git: Number(m[2]), api: Number(m[3]) }))
    const bad = samples.filter((s) => s.git !== 0 || s.api !== 200)
    console.log(JSON.stringify({ runId, sandbox: id, minutes, samples: samples.length, failures: bad, first: samples[0]?.t, last: samples.at(-1)?.t }))
    failed = samples.length === 0 || bad.length > 0
  } catch (error) {
    failed = true
    log(`error: ${String(error)}`)
  } finally {
    for (const step of cleanup) await step().catch((e) => log(`cleanup: ${String(e)}`))
    log('cleaned up')
  }
  process.exit(failed ? 1 : 0)
}
void main()
