// A9: agents are signed out on a sandbox before Orca deletes it, and environment-build images are
// scrubbed of agent sign-ins before anyone else boots them.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SIGNOUT_TIMEOUT_MS, signOutAgentsBeforeDelete } from '../src/agent-signout'
import { ProviderError, type RunCommandParams, type SandboxProviderApi } from '../src/sandbox-provider'
import { createHarness } from './harness'

const create = { workspaceId: 'ws-1', machineSize: 'standard' }
const isSignout = (params: RunCommandParams) => params.command === 'bash' && params.args?.[2] === 'orca-agent-signout'
const SCRIPT = fileURLToPath(new URL('../image/vm/orca-agent-signout', import.meta.url).href)

describe('sign agents out before delete', () => {
  it('runs each agent sign-out on the running VM before the provider delete', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    const name = `orca-test-${body.sandbox.id}`
    const seen: { scrubOnly: boolean; boxAlive: boolean }[] = []
    h.vercel.commandHandler = (params) => {
      if (isSignout(params)) {
        seen.push({ scrubOnly: params.args!.includes('--scrub-only'), boxAlive: h.vercel.boxes.has(name) })
      }
      return undefined
    }
    const destroyed = await h.call('DELETE', `/v1/sandboxes/${body.sandbox.id}`)
    expect(destroyed.body.sandbox.status).toBe('destroyed')
    expect(seen).toEqual([{ scrubOnly: false, boxAlive: true }])
    expect(h.vercel.boxes.has(name)).toBe(false)
  })

  it('still deletes when the sign-out fails or the provider errors', async () => {
    for (const failure of ['exit', 'throw'] as const) {
      const h = await createHarness()
      const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
      h.vercel.commandHandler = (params) => {
        if (!isSignout(params)) {
          return undefined
        }
        if (failure === 'throw') {
          throw new ProviderError(502, 'bad_gateway')
        }
        return { exitCode: 1, stdout: '', stderr: 'boom' }
      }
      const destroyed = await h.call('DELETE', `/v1/sandboxes/${body.sandbox.id}`)
      expect(destroyed.body.sandbox.status).toBe('destroyed')
      expect(h.vercel.boxes.size).toBe(0)
    }
  })

  it('never wakes a suspended sandbox to sign out', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    await h.call('POST', `/v1/sandboxes/${body.sandbox.id}/suspend`)
    const before = h.vercel.commands.length
    const destroyed = await h.call('DELETE', `/v1/sandboxes/${body.sandbox.id}`)
    expect(destroyed.body.sandbox.status).toBe('destroyed')
    expect(h.vercel.commands.slice(before).filter((c) => c.args?.[2] === 'orca-agent-signout')).toEqual([])
  })

  describe('bounded wait', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('gives up after the timeout when the VM never answers', async () => {
      vi.useFakeTimers()
      const provider = { runCommand: () => new Promise(() => undefined) } as unknown as SandboxProviderApi
      const done = signOutAgentsBeforeDelete(provider, 'sess', { sandboxId: 'sb' })
      await vi.advanceTimersByTimeAsync(AGENT_SIGNOUT_TIMEOUT_MS)
      await expect(done).resolves.toBe(false)
    })
  })
})

describe('scrub agent sign-ins on clone (environment builds)', () => {
  const RESULT = JSON.stringify({ durationSec: 1, repos: [], diskUsedBytes: 1, diskTotalBytes: 2 })

  async function setup() {
    const h = await createHarness()
    h.vercel.buildResult = RESULT
    const admin = await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' })
    const call = (method: string, path: string, body?: unknown) => h.call(method, path, { bearer: admin, body })
    const created = await call('POST', '/v1/environments', {
      name: 'Default',
      repos: [{ url: 'acme/web', defaultBranch: 'main' }],
      installScript: 'claude auth login',
      envVarNames: []
    })
    const envId: string = created.body.environment.id
    async function build() {
      const started = await call('POST', `/v1/environments/${envId}/builds`)
      const command = [...h.vercel.buildCommands.values()].at(-1)!
      command.exitCode = 0
      h.advance(1000)
      return (await call('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)).body.build
    }
    return { h, build }
  }

  it('scrubs agent auth (files only) before the build is snapshotted', async () => {
    const { h, build } = await setup()
    const order: string[] = []
    const createSnapshot = h.vercel.createSnapshot.bind(h.vercel)
    h.vercel.createSnapshot = async (sessionId, expirationMs) => {
      order.push('snapshot')
      return createSnapshot(sessionId, expirationMs)
    }
    h.vercel.commandHandler = (params) => {
      if (isSignout(params)) {
        order.push(params.args!.includes('--scrub-only') ? 'scrub' : 'signout')
      }
      return undefined
    }
    expect(await build()).toMatchObject({ status: 'succeeded', active: true })
    expect(order.slice(0, 2)).toEqual(['scrub', 'snapshot'])
  })

  it('fails the build, with no image, when the scrub cannot confirm the sign-ins are gone', async () => {
    const { h, build } = await setup()
    const images = () => [...h.vercel.snapshots.values()].filter((s) => s.creationMethod === 'manual').length
    h.vercel.commandHandler = (params) =>
      isSignout(params) ? { exitCode: 0, stdout: '{"loggedOut":0,"left":1}\n', stderr: '' } : undefined
    expect(await build()).toMatchObject({ status: 'failed', failedStep: 'record', active: false })
    expect(images()).toBe(0)
  })
})

describe('orca-agent-signout (VM script)', () => {
  let home = ''
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function seed(): void {
    home = mkdtempSync(join(tmpdir(), 'orca-signout-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.orcad-data/codex-accounts/a'), { recursive: true })
    writeFileSync(join(home, '.claude/.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}')
    writeFileSync(join(home, '.codex/auth.json'), '{"tokens":{}}')
    writeFileSync(join(home, '.codex/config.toml'), 'model = "x"\n')
    writeFileSync(join(home, '.orcad-data/codex-accounts/a/auth.json'), '{}')
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' }, primaryApiKey: 'sk', hasCompletedOnboarding: true })
    )
  }

  function run(args: string[]): { loggedOut: number; left: number } {
    const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }
    return JSON.parse(execFileSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' }).trim())
  }

  it('--scrub-only removes credential files and sign-in fields, keeping settings and running no CLI', () => {
    seed()
    const bin = join(home, '.local/bin')
    mkdirSync(bin, { recursive: true })
    for (const cli of ['claude', 'codex']) {
      writeFileSync(join(bin, cli), `#!/bin/sh\ntouch "${home}/ran-${cli}"\n`)
      chmodSync(join(bin, cli), 0o755)
    }
    expect(run(['--scrub-only'])).toEqual({ loggedOut: 0, left: 0 })
    expect(existsSync(join(home, '.claude/.credentials.json'))).toBe(false)
    expect(existsSync(join(home, '.codex/auth.json'))).toBe(false)
    expect(existsSync(join(home, '.orcad-data/codex-accounts/a/auth.json'))).toBe(false)
    expect(existsSync(join(home, '.codex/config.toml'))).toBe(true)
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true })
    expect(existsSync(join(home, 'ran-claude'))).toBe(false)
    expect(existsSync(join(home, 'ran-codex'))).toBe(false)
  })

  it('runs each agent logout, then removes the files even when a logout fails', () => {
    seed()
    const bin = join(home, '.local/bin')
    mkdirSync(bin, { recursive: true })
    // A portable stand-in for coreutils timeout, so the test does not depend on the host having it.
    writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n')
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >"${home}/claude-args"\n`)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n')
    for (const file of ['timeout', 'claude', 'codex']) {
      chmodSync(join(bin, file), 0o755)
    }
    expect(run([])).toEqual({ loggedOut: 1, left: 0 })
    expect(readFileSync(join(home, 'claude-args'), 'utf8').trim()).toBe('auth logout')
    expect(existsSync(join(home, '.codex/auth.json'))).toBe(false)
    expect(existsSync(join(home, '.claude/.credentials.json'))).toBe(false)
  })
})
