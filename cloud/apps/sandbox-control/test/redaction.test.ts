// Injected values (cloud secrets, GitHub tokens, pairing codes) must never reach provider-retained
// metadata: Vercel keeps a command's args and stdout/stderr as logs (GET .../cmd/:id, .../logs) but
// not its env (verified live) and not files read back through the files API.
import { execFileSync } from 'node:child_process'
import { createCipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { resolveOrcadReadyLine } from '../src/orcad-ready'
import type { ProviderSandboxState, SandboxProviderApi } from '../src/sandbox-provider'
import { START_COMMAND, refreshSessionEnv, startOrcad } from '../src/sandbox-vm-commands'
import { createVercelSandboxApi } from '../src/vercel-sandbox-api'
import { createFakeVercel, READY_PATH } from './fake-vercel'
import { createHarness } from './harness'

const PAIRING = 'orca://pair?code=eyJ2IjoxLCJrZXkiOiJwYWlyaW5nLXNlY3JldCJ9'
const SECRET = 'sk-ant-api03-' + 'k'.repeat(60)
const CUSTOM = 'my-unshaped-gateway-credential-0099'
const OFFER = { schemaVersion: 1, pairingCode: PAIRING, projectRoot: '/vercel/sandbox/project' }

/** What orca-sandbox-start prints: `tail -n 1 ready.json | openssl enc -aes-256-ctr -K key -iv iv -nosalt`. */
function pointerLine(keyHex: string, offerLine: string): { schemaVersion: 1; readyFile: string; sealedOffer: string } {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-ctr', Buffer.from(keyHex, 'hex'), iv)
  const sealed = Buffer.concat([cipher.update(`${offerLine}\n`), cipher.final()])
  return { schemaVersion: 1, readyFile: READY_PATH, sealedOffer: `${iv.toString('hex')}.${sealed.toString('base64')}` }
}

function stateFor(sessionId: string): ProviderSandboxState {
  return {
    sandbox: { name: 'sbx', status: 'running', currentSessionId: sessionId, currentSnapshotId: null, tags: {} },
    session: { id: sessionId, status: 'running', startedAt: 0, timeoutMs: 1 },
    routes: [{ port: 6768, url: 'https://sb.vercel.run' }]
  }
}

describe('orcad pairing offer transport', () => {
  it('asks the image for a pointer and reads the offer through the files API, keeping it out of stdout', async () => {
    const provider = {
      runCommand: vi.fn(async (_id: string, params: { env?: Record<string, string> }) => {
        expect(params.env?.ORCA_READY_VIA).toBe('file')
        return { exitCode: 0, stdout: `boot\n{"schemaVersion":1,"readyFile":"${READY_PATH}"}\n`, stderr: '' }
      }),
      readFile: vi.fn(async (_id: string, path: string) => (path === READY_PATH ? `x\n${JSON.stringify(OFFER)}\n` : null))
    } as unknown as SandboxProviderApi
    const ready = await startOrcad(provider, stateFor('sess_1'), {
      sandboxId: 'sbx_1',
      secretEnv: { ANTHROPIC_API_KEY: SECRET, CUSTOM_TOKEN: CUSTOM }
    })
    expect(ready.pairingCode).toBe(PAIRING)
    const call = vi.mocked(provider.runCommand).mock.calls[0]![1] as { command: string; args?: string[] }
    // Secrets ride env (not retained) and never args (retained and listable).
    expect(call.command).toBe(START_COMMAND)
    expect(JSON.stringify(call.args ?? [])).not.toContain(SECRET)
  })

  it('opens the offer sealed with this call key without the files API, keeping the key out of args', async () => {
    let seenArgs = ''
    const provider = {
      runCommand: vi.fn(async (_id: string, params: { args?: string[]; env?: Record<string, string> }) => {
        seenArgs = JSON.stringify(params.args ?? [])
        const key = params.env?.ORCA_READY_KEY ?? ''
        expect(key).toMatch(/^[0-9a-f]{64}$/)
        return { exitCode: 0, stdout: `boot\n${JSON.stringify(pointerLine(key, JSON.stringify(OFFER)))}\n`, stderr: '' }
      }),
      readFile: vi.fn()
    } as unknown as SandboxProviderApi
    const ready = await startOrcad(provider, stateFor('sess_1'), {
      sandboxId: 'sbx_1',
      prelude: { script: 'echo prelude', env: {} }
    })
    expect(ready).toEqual(OFFER)
    expect(provider.readFile).not.toHaveBeenCalled()
    // Only the start script may hold the key: the prelude runs with it unset.
    expect(seenArgs).toContain('-u ORCA_READY_KEY')
    expect(seenArgs).not.toMatch(/[0-9a-f]{64}/)
  })

  it('reads the file when the sealed offer does not open with the key', async () => {
    const otherKey = 'ab'.repeat(32)
    const provider = {
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(pointerLine(otherKey, JSON.stringify(OFFER)))}\n`,
        stderr: ''
      })),
      readFile: vi.fn(async () => `${JSON.stringify(OFFER)}\n`)
    } as unknown as SandboxProviderApi
    expect(await startOrcad(provider, stateFor('sess_1'), { sandboxId: 'sbx_1' })).toEqual(OFFER)
    expect(provider.readFile).toHaveBeenCalledWith('sess_1', READY_PATH)
    // Garbage in place of the sealed offer is no different.
    expect(await resolveOrcadReadyLine(provider, 's', JSON.stringify({ readyFile: READY_PATH, sealedOffer: 'x.y' }), new Uint8Array(32))).toEqual(OFFER)
  })

  it('still accepts the offer line from images that predate the pointer', async () => {
    const provider = { readFile: vi.fn() } as unknown as SandboxProviderApi
    expect(await resolveOrcadReadyLine(provider, 's', JSON.stringify(OFFER))).toEqual(OFFER)
    expect(provider.readFile).not.toHaveBeenCalled()
  })

  it('refuses pointers to anything but a ready.json path', async () => {
    const provider = { readFile: vi.fn(async () => JSON.stringify(OFFER)) } as unknown as SandboxProviderApi
    for (const readyFile of ['/etc/shadow', '/home/x/../../etc/ready.json', 'relative/ready.json']) {
      await expect(resolveOrcadReadyLine(provider, 's', JSON.stringify({ readyFile }))).rejects.toThrow()
    }
    expect(provider.readFile).not.toHaveBeenCalled()
  })

  it('the fake provider path end to end: the offer never appears in any command stdout', async () => {
    const fake = createFakeVercel(() => 0)
    const created = await fake.createSandbox({
      name: 'sbx',
      snapshotId: 'snap',
      vcpus: 2,
      region: 'iad1',
      timeoutMs: 60_000,
      ports: [6768],
      networkPolicy: { allow: {} },
      snapshotExpirationMs: 1,
      tags: {}
    })
    const runCommand = fake.runCommand.bind(fake)
    const stdouts: string[] = []
    fake.runCommand = async (id, params) => {
      const result = await runCommand(id, params)
      stdouts.push(result.stdout)
      return result
    }
    const ready = await startOrcad(fake, created, { sandboxId: 'sbx_1' })
    expect(ready.pairingCode).toContain('orca://pair')
    expect(stdouts.join('\n')).not.toContain('orca://pair')
  })
})

describe('Vercel files API', () => {
  it('reads a file with POST fs/read and maps 404 to null', async () => {
    const calls: { url: string; body: unknown }[] = []
    const api = createVercelSandboxApi({
      token: 't',
      teamId: 'team',
      projectId: 'prj',
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
        return String(url).includes('missing')
          ? Response.json({ error: { code: 'not_found' } }, { status: 404 })
          : new Response('line\n', { headers: { 'content-type': 'application/octet-stream' } })
      }) as unknown as typeof fetch
    })
    expect(await api.readFile('sess_1', READY_PATH)).toBe('line\n')
    expect(calls[0]!.url).toContain('/v2/sandboxes/sessions/sess_1/fs/read')
    expect(calls[0]!.body).toEqual({ path: READY_PATH })
    expect(await api.readFile('missing', READY_PATH)).toBeNull()
  })
})

describe('secret env refresh', () => {
  it('passes values only as command env, never args', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '{"names":1}\n', stderr: '' }))
    await refreshSessionEnv({ runCommand } as unknown as SandboxProviderApi, 'sess', { ANTHROPIC_API_KEY: SECRET }, 1)
    const params = (runCommand.mock.calls[0] as unknown as [string, { args?: string[]; env: Record<string, string> }])[1]
    expect(JSON.stringify(params.args ?? [])).not.toContain(SECRET)
    expect(params.env.ORCA_SECRET_ENV).toBeDefined()
  })
})

describe('orca-sandbox-start log tails (provider-retained stderr)', () => {
  const script = readFileSync(fileURLToPath(new URL('../image/vm/orca-sandbox-start', import.meta.url).href), 'utf8')
  const fn = /^redact_log\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0]

  function redact(log: string, agentEnv: string[]): string {
    const program = `set -euo pipefail\n${fn}\nagent_env=()\nfor kv in "$@"; do agent_env+=("$kv"); done\nprintf '%s' "$LOG" | redact_log`
    return execFileSync('bash', ['--noprofile', '--norc', '-c', program, 'redact', ...agentEnv], { env: { LOG: log, PATH: process.env.PATH }, encoding: 'utf8' })
  }

  it('is defined in the start script and used for every log tail', () => {
    expect(fn).toBeDefined()
    const tails = script.split('\n').filter((line) => /tail -n \d+ "\$STATE\/(orcad|clone)\.log"/.test(line))
    expect(tails.length).toBeGreaterThan(0)
    for (const line of tails) {
      expect(line).toContain('| redact_log')
    }
  })

  it('strips exact injected values, token shapes, JWTs and pairing codes', () => {
    const jwtToken = `ghs_${'A'.repeat(36)}.eyJpc3MiOiJnaXRodWIifQ.c2lnbmF0dXJlLWJ5dGVz`
    const out = redact(
      [
        `Error: spawn failed with ${CUSTOM}`,
        `pair at ${PAIRING}`,
        `anthropic ${SECRET}`,
        `git ${jwtToken}`,
        'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eXoifQ.c2lnbmF0dXJlMTIz',
        'Authorization: Bearer abc.def-ghi',
        'gateway vck_abcdefghijklmnopqrstuvwxyz'
      ].join('\n'),
      [`CUSTOM_TOKEN=${CUSTOM}`, 'SHORT=abc']
    )
    for (const leaked of [CUSTOM, 'pairing-secret', PAIRING, SECRET, 'c2lnbmF0dXJlLWJ5dGVz', 'c2lnbmF0dXJlMTIz', 'abc.def-ghi', 'vck_abc']) {
      expect(out).not.toContain(leaked)
    }
    expect(out).toContain('Error: spawn failed with [REDACTED]')
  })

  it('works with no injected env (set -u and an empty array)', () => {
    expect(redact('plain line', [])).toBe('plain line\n')
  })
})

describe('GitHub credential scope', () => {
  const github = {
    tokenForRepo: async (url: string) =>
      url.startsWith('https://github.com/') ? { token: 'ghs_scoped', expiresAt: Date.now() + 3_600_000 } : null,
    getInstallation: async () => null,
    getRepoInstallation: async () => null
  }
  const proxy = { EGRESS_PROXY_URL: 'https://control.example/v1/egress/proxy' }

  it('the git extraheader is configured only for https://github.com/', () => {
    const script = readFileSync(fileURLToPath(new URL('../image/vm/orca-sandbox-start', import.meta.url).href), 'utf8')
    const configs = script.split('\n').filter((line) => line.includes('git config') && line.includes('extraheader'))
    expect(configs.length).toBeGreaterThan(0)
    for (const line of configs) {
      expect(line).toContain('git config --global http.https://github.com/.extraheader')
    }
  })

  it('real tokens are swapped only on github.com (git) and api.github.com (proxy), and only for placeholders', async () => {
    const h = await createHarness(proxy, { github })
    await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-scope', machineSize: 'standard', repo: { url: 'https://github.com/nwparker/orca-sandbox-push-test.git' } }
    })
    const [box] = [...h.vercel.boxes.values()]
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)!
    const placeholder = start.env.ORCA_GITHUB_PLACEHOLDER!
    expect(placeholder).toMatch(/^orca-ph-/)
    for (const [host, rules] of Object.entries(box!.policy.allow)) {
      const text = JSON.stringify(rules)
      if (text.includes('ghs_scoped')) {
        expect(host).toBe('github.com')
      }
      if (text.includes(placeholder)) {
        expect(['api.github.com']).toContain(host)
      }
    }
    // Credential hosts end in the deny rule: a request without the placeholder gets nothing.
    expect(box!.policy.allow['github.com']!.at(-1)).toMatchObject({ response: { statusCode: 403 } })
    expect(box!.policy.allow['api.github.com']!.at(-1)).toMatchObject({ response: { statusCode: 403 } })
  })

  it('repos hosted outside github.com get no GitHub token, header or placeholder', async () => {
    const h = await createHarness(proxy, { github })
    await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-gitlab', machineSize: 'standard', repo: { url: 'https://gitlab.com/acme/app.git' } }
    })
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)!
    expect(start.env.ORCA_GITHUB_PLACEHOLDER).toBeUndefined()
    expect(start.env.ORCA_GIT_EXTRAHEADER).toBeUndefined()
    const [box] = [...h.vercel.boxes.values()]
    expect(JSON.stringify(box!.policy)).not.toContain('ghs_scoped')
  })
})
