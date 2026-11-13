// SEC-2: an environment build's snapshot is the team's saved environment, booted by every member's
// workspace. A build gets only the team secrets an admin named, never a model key, and cannot succeed
// with one of their values left on disk.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_BUILD_SCRIPT } from '../image/vm-scripts.generated'
import { buildSecretNames } from '../src/environment-builds'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
// Fake values only.
const NPM_TOKEN = 'npm_fakeRegistryToken0123456789'
const MODEL_KEY = 'sk-ant-api03-TEAM-fake-0000-aaaa'
const OPENAI_KEY = 'sk-proj-fake-team-openai-2222'
const UNNAMED = 'team-unnamed-secret-value'
const PERSONAL = 'personal-npm-token-value'
const REPO_VALUE = 'repo-scoped-secret-value'
const ALL_VALUES = [NPM_TOKEN, MODEL_KEY, OPENAI_KEY, UNNAMED, PERSONAL, REPO_VALUE]

const RESULT = JSON.stringify({ durationSec: 3, repos: [], diskUsedBytes: 1, diskTotalBytes: 2 })
const log = (data: string, stream = 'stdout') => `${JSON.stringify({ data, stream })}\n`

const logs: string[] = []
beforeEach(() => {
  logs.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  for (const value of ALL_VALUES) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

async function setup(envVarNames: string[]) {
  const h = await createHarness({ SECRETS_KEK: KEK })
  h.vercel.buildResult = RESULT
  const admin = await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' })
  const call = (method: string, path: string, body?: unknown) => h.call(method, path, { bearer: admin, body })
  const put = (scope: string, name: string, value: string, repo?: string) =>
    call('PUT', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { value })
  await put('org', 'NPM_TOKEN', NPM_TOKEN)
  await put('org', 'ANTHROPIC_API_KEY', MODEL_KEY)
  await put('org', 'OPENAI_API_KEY', OPENAI_KEY)
  await put('org', 'UNNAMED', UNNAMED)
  // Same names in the other scopes: a build must never read them.
  await put('personal', 'PERSONAL_TOKEN', PERSONAL)
  await put('repo', 'REPO_TOKEN', REPO_VALUE, 'acme/web')
  const created = await call('POST', '/v1/environments', {
    name: 'Default',
    repos: [{ url: 'acme/web', defaultBranch: 'main' }],
    installScript: 'pnpm install --frozen-lockfile',
    envVarNames
  })
  expect(created.status).toBe(200)
  const envId: string = created.body.environment.id
  async function build(exitCode: number, output = log('::orca-step:: install\nok\n')) {
    const started = await call('POST', `/v1/environments/${envId}/builds`)
    expect(started.status).toBe(200)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.logs = output
    command.exitCode = exitCode
    h.advance(1000)
    return { build: (await call('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)).body.build, command }
  }
  return { h, call, envId, build }
}

describe('team secrets in environment builds (SEC-2)', () => {
  it('splits the named secrets: model keys are withheld, the rest injected', () => {
    expect(buildSecretNames(['NPM_TOKEN', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'AI_GATEWAY_API_KEY', 'GEMINI_API_KEY', 'DATABASE_URL'])).toEqual({
      injected: ['NPM_TOKEN', 'DATABASE_URL'],
      withheld: ['ANTHROPIC_API_KEY', 'AI_GATEWAY_API_KEY', 'GEMINI_API_KEY']
    })
    expect(buildSecretNames([])).toEqual({ injected: [], withheld: [] })
  })

  it('gives a build no secret at all unless the environment names it', async () => {
    const { build } = await setup([])
    const { command, build: done } = await build(0)
    expect(done.status).toBe('succeeded')
    const sent = JSON.stringify(command.env)
    for (const value of ALL_VALUES) {
      expect(sent).not.toContain(value)
    }
    expect(command.env).not.toHaveProperty('ORCA_BUILD_SECRET_NAMES')
    expect(command.env).not.toHaveProperty('ORCA_BUILD_WITHHELD_SECRETS')
  })

  it('injects only the named team secrets, and never a model key even when it is named', async () => {
    const { build } = await setup(['NPM_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PERSONAL_TOKEN', 'REPO_TOKEN', 'MISSING'])
    const { command } = await build(0)
    expect(command.env.NPM_TOKEN).toBe(NPM_TOKEN)
    // The script scopes and scans exactly the names it was really given.
    expect(command.env.ORCA_BUILD_SECRET_NAMES).toBe('NPM_TOKEN')
    expect(command.env.ORCA_BUILD_WITHHELD_SECRETS).toBe('ANTHROPIC_API_KEY OPENAI_API_KEY')
    expect(command.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(command.env).not.toHaveProperty('OPENAI_API_KEY')
    const sent = JSON.stringify({ env: command.env, args: command.args })
    for (const value of [MODEL_KEY, OPENAI_KEY, UNNAMED, PERSONAL, REPO_VALUE]) {
      expect(sent).not.toContain(value)
    }
    // Counts only in the control plane's own log.
    expect(logs.some((line) => line.includes('environment_build_secrets') && line.includes('"injected":1') && line.includes('"withheld":2'))).toBe(true)
  })

  it('fails the build and takes no snapshot when the script reports a secret left on disk (exit 40)', async () => {
    const { h, call, envId, build } = await setup(['NPM_TOKEN'])
    const good = (await build(0)).build
    expect(good).toMatchObject({ status: 'succeeded', active: true })
    // The fake models a deleted VM's automatic stop snapshot; the real provider deletes a failed build VM
    // with deleteOrphanSnapshots and the box is non-persistent. What matters: no image was taken of it.
    const images = () => [...h.vercel.snapshots.values()].filter((snapshot) => snapshot.creationMethod === 'manual').length
    const snapshotsBefore = images()

    const leaked = await build(
      40,
      log(`::orca-step:: record\n::orca-error:: NPM_TOKEN was left in /home/vercel-sandbox/.npmrc. token=${NPM_TOKEN}\n`)
    )
    expect(leaked.build).toMatchObject({ status: 'failed', error: 'secret_in_image', failedStep: 'record', active: false, activatable: false })
    // No image was made from that VM, the VM is gone, and workspaces keep the last good build.
    expect(images()).toBe(snapshotsBefore)
    expect(h.raw.prepare('SELECT snapshot_id FROM environment_builds WHERE id = ?').get(leaked.build.id)).toEqual({ snapshot_id: null })
    expect([...h.vercel.boxes.keys()].filter((name) => name.includes('envbuild'))).toEqual([])
    expect((await call('GET', `/v1/environments/${envId}`)).body.environment.activeBuildId).toBe(good.id)
    // The stored log names the secret and the file, never the value (even if the script printed it).
    const stored = h.raw.prepare('SELECT data FROM environment_build_logs WHERE build_id = ?').all(leaked.build.id) as { data: string }[]
    const text = stored.map((row) => row.data).join('')
    expect(text).toContain('NPM_TOKEN was left in /home/vercel-sandbox/.npmrc')
    expect(text).toContain('[secret NPM_TOKEN]')
    expect(text).not.toContain(NPM_TOKEN)
  })
})

// The real script's functions, run by a real bash against a scratch tree.
describe('environment-build.sh secret handling (SEC-2)', () => {
  const script = readFileSync(fileURLToPath(new URL('../image/env/environment-build.sh', import.meta.url).href), 'utf8')
  const take = /^take_secrets\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0]
  const scan = /^scan_secrets\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0]
  const PEM = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7fakefake', 'c2hvcnQ=', '-----END PRIVATE KEY-----'].join('\n')
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-build-scan-'))
    mkdirSync(join(dir, 'out'))
    mkdirSync(join(dir, 'root/home/.config'), { recursive: true })
    mkdirSync(join(dir, 'root/repo/node_modules/pkg'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** take_secrets, then `install` (as the install script would run), then scan_secrets. */
  function run(install: string, secrets: Record<string, string> = { NPM_TOKEN, SHORT: 'abc', PEM_KEY: PEM }): { status: number; out: string } {
    const program = [
      'set -uo pipefail',
      'secret_names=()',
      'secret_values=()',
      take,
      scan,
      'take_secrets',
      // Like the script's install step: the child gets the secrets back, nothing else does.
      '( if [ "${#secret_names[@]}" -gt 0 ]; then for i in "${!secret_names[@]}"; do export "${secret_names[$i]}=${secret_values[$i]}"; done; fi',
      '  cd "$ORCA_SCAN_ROOT" && bash -euo pipefail -c "$INSTALL" ) || exit 20',
      'echo "outer:${NPM_TOKEN-unset}:${ORCA_BUILD_SECRET_NAMES-unset}"',
      'scan_secrets || exit 40',
      'echo scan-clean'
    ].join('\n')
    try {
      const out = execFileSync('bash', ['--noprofile', '--norc', '-c', program], {
        env: {
          PATH: process.env.PATH,
          OUT: join(dir, 'out'),
          ORCA_SCAN_ROOT: join(dir, 'root'),
          ORCA_BUILD_SECRET_NAMES: Object.keys(secrets).join(' '),
          INSTALL: install,
          ...secrets
        },
        encoding: 'utf8'
      })
      return { status: 0, out }
    } catch (error) {
      const failed = error as { status: number; stdout: string }
      return { status: failed.status, out: failed.stdout }
    }
  }

  it('is defined in the build script, which scans before it records and is embedded in the Worker', () => {
    expect(take).toBeDefined()
    expect(scan).toBeDefined()
    expect(script).toMatch(/\ntake_secrets\n/)
    expect(script).toMatch(/\nstep record\nscan_secrets \|\| exit 40\n/)
    // The scan runs before the result file exists: a failed scan can never look like a finished build.
    expect(script.indexOf('scan_secrets || exit 40')).toBeLessThan(script.indexOf('>"$OUT/result.json"'))
    expect(ENVIRONMENT_BUILD_SCRIPT).toBe(script)
  })

  it('hands secrets to the install script only, and passes a build that used one without writing it', () => {
    const { status, out } = run('test "$NPM_TOKEN" = "$EXPECTED" && echo used > repo/node_modules/pkg/index.js'.replace('$EXPECTED', NPM_TOKEN))
    expect(status).toBe(0)
    // Gone from the build script's own environment (clones, Orca's steps), names list included.
    expect(out).toContain('outer:unset:unset')
    expect(out).toContain('scan-clean')
  })

  it('fails when the install script leaves a value in a file, naming the secret and the path but never the value', () => {
    const { status, out } = run('echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > home/.npmrc')
    expect(status).toBe(40)
    expect(out).toContain(`::orca-error:: NPM_TOKEN was left in ${join(dir, 'root/home/.npmrc')}.`)
    expect(out).not.toContain(NPM_TOKEN)
    expect(out).not.toContain('scan-clean')
  })

  it('finds a value deep in the tree, in a dotfile, and a multi-line key by its longest line', () => {
    const deep = run('printf "TOKEN=%s\\n" "$NPM_TOKEN" > repo/node_modules/pkg/.env.local; printf "%s\\n" "$PEM_KEY" > home/.config/key.pem')
    expect(deep.status).toBe(40)
    expect(deep.out).toContain('NPM_TOKEN was left in')
    expect(deep.out).toContain('.env.local')
    expect(deep.out).toContain('PEM_KEY was left in')
    expect(deep.out).toContain('key.pem')
    expect(deep.out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7fakefake')
  })

  it('ignores values too short to search for and PEM armour lines (no false failures)', () => {
    const { status } = run('echo "abc abc abc" > home/notes.txt; echo "-----BEGIN PRIVATE KEY-----" > home/other.pem; echo c2hvcnQ= > home/b64.txt')
    expect(status).toBe(0)
  })

  it('searches only files the build changed, and everything when the install script removed the marker', () => {
    writeFileSync(join(dir, 'root/home/preexisting.txt'), `from the base image ${NPM_TOKEN}\n`)
    expect(run('true').status).toBe(0)
    const tampered = run('rm -f "$OUT/.scan-since"')
    expect(tampered.status).toBe(40)
    expect(tampered.out).toContain('preexisting.txt')
  })

  it('passes with no secrets at all', () => {
    expect(run('echo hi > home/file', {}).status).toBe(0)
  })
})
