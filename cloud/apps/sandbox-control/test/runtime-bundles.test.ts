import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_REFRESH_SCRIPT,
  handleRuntimeBundleRoute,
  runtimeBundleFor,
  runtimeBundleUrl,
  type RuntimeBundleStore
} from '../src/runtime-bundles'

const SECRET = 'control-plane-token-for-tests-0000000000'
const COMMIT = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const RT = 'c'.repeat(64)
const NOW = 1_800_000_000_000

function memoryStore(): RuntimeBundleStore & { objects: Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }> } {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>()
  return {
    objects,
    head: async (key) => objects.get(key) ?? null,
    get: async (key) => {
      const object = objects.get(key)
      return object ? { body: new Response(object.bytes).body!, size: object.bytes.byteLength } : null
    },
    put: async (key, value, options) => {
      objects.set(key, { bytes: new Uint8Array(value), customMetadata: options.customMetadata })
    }
  }
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('runtime bundle route (ENV-STALE)', () => {
  it('stores what a signed PUT uploads, keyed by commit, with the hash it computed itself', async () => {
    const store = memoryStore()
    const bytes = new TextEncoder().encode('bundle-bytes')
    const put = await runtimeBundleUrl('https://cp.test', SECRET, 'PUT', COMMIT, NOW)
    const response = await handleRuntimeBundleRoute(
      new Request(put, { method: 'PUT', body: bytes, headers: { 'x-orca-sha256': sha(bytes), 'x-orca-runtime': RT, 'content-length': String(bytes.byteLength) } }),
      new URL(put),
      { store, secret: SECRET, now: NOW }
    )
    expect(response?.status).toBe(200)
    expect(await runtimeBundleFor(store, COMMIT)).toEqual({ commit: COMMIT, sha256: sha(bytes), runtime: RT })

    const get = await runtimeBundleUrl('https://cp.test', SECRET, 'GET', COMMIT, NOW)
    const download = await handleRuntimeBundleRoute(new Request(get), new URL(get), { store, secret: SECRET, now: NOW })
    expect(new Uint8Array(await download!.arrayBuffer())).toEqual(bytes)
  })

  it('refuses unsigned, expired, wrong-method and mismatched uploads', async () => {
    const store = memoryStore()
    const bytes = new TextEncoder().encode('x')
    const headers = { 'x-orca-sha256': sha(bytes), 'x-orca-runtime': RT, 'content-length': '1' }
    const get = await runtimeBundleUrl('https://cp.test', SECRET, 'GET', COMMIT, NOW)
    const route = (url: string, init: RequestInit, now = NOW) => handleRuntimeBundleRoute(new Request(url, init), new URL(url), { store, secret: SECRET, now })
    // A download URL can't upload; an unsigned or expired one can't do anything.
    expect((await route(get, { method: 'PUT', body: bytes, headers }))?.status).toBe(403)
    expect((await route(`https://cp.test/v1/runtime-bundles/${COMMIT}.tgz`, {}))?.status).toBe(403)
    expect((await route(get, {}, NOW + 11 * 60_000))?.status).toBe(403)
    const put = await runtimeBundleUrl('https://cp.test', SECRET, 'PUT', COMMIT, NOW)
    expect((await route(put, { method: 'PUT', body: bytes, headers: { ...headers, 'x-orca-sha256': 'd'.repeat(64) } }))?.status).toBe(400)
    expect(store.objects.size).toBe(0)
    expect(await runtimeBundleFor(store, COMMIT)).toBeNull()
  })
})

describe('boot-time refresh script', () => {
  let dir = ''
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function vm(commit: string): string {
    dir = mkdtempSync(join(tmpdir(), 'orca-rt-'))
    const root = join(dir, 'opt')
    mkdirSync(join(root, 'runtime/orcad'), { recursive: true })
    mkdirSync(join(root, 'runtime/orca-cli'), { recursive: true })
    mkdirSync(join(root, `runtime/runtimes/node-${RT}`), { recursive: true })
    writeFileSync(join(root, 'runtime/orcad/SOURCE_COMMIT'), commit)
    writeFileSync(join(root, 'runtime/orca-cli/cli.cjs'), `cli-${commit}`)
    return root
  }

  function bundle(commit: string): { path: string; sha: string } {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'runtime/orcad'), { recursive: true })
    mkdirSync(join(src, 'runtime/orca-cli'), { recursive: true })
    writeFileSync(join(src, 'runtime/orcad/SOURCE_COMMIT'), commit)
    writeFileSync(join(src, 'runtime/orca-cli/cli.cjs'), `cli-${commit}`)
    const path = join(dir, 'b.tgz')
    execFileSync('tar', ['czf', path, '-C', src, 'runtime/orcad', 'runtime/orca-cli'])
    return { path, sha: sha(readFileSync(path)) }
  }

  const run = (root: string, env: Record<string, string>) =>
    execFileSync('bash', ['-c', RUNTIME_REFRESH_SCRIPT], { env: { PATH: process.env.PATH, ORCA_ROOT: root, RT, ...env }, encoding: 'utf8' }).trim()

  it('installs the active golden orcad into an older image, verified by the expected hash', () => {
    const root = vm(OLD)
    const b = bundle(COMMIT)
    expect(run(root, { WANT: COMMIT, SHA: b.sha, URL: `file://${b.path}` })).toBe(`refreshed ${OLD}`)
    expect(readFileSync(join(root, 'runtime/orcad/SOURCE_COMMIT'), 'utf8')).toBe(COMMIT)
    expect(readFileSync(join(root, 'runtime/orca-cli/cli.cjs'), 'utf8')).toBe(`cli-${COMMIT}`)
    expect(existsSync(join(root, 'runtime/orcad.old'))).toBe(false)
  })

  it('keeps the old orcad on a hash mismatch, a wrong commit, a missing runtime or a failed download', () => {
    const root = vm(OLD)
    const b = bundle(COMMIT)
    expect(run(root, { WANT: COMMIT, SHA: 'e'.repeat(64), URL: `file://${b.path}` })).toBe(`skip_sha ${OLD}`)
    expect(run(root, { WANT: 'f'.repeat(40), SHA: b.sha, URL: `file://${b.path}` })).toBe(`skip_commit ${OLD}`)
    expect(run(root, { WANT: COMMIT, SHA: b.sha, URL: `file://${dir}/missing.tgz` })).toBe(`skip_download ${OLD}`)
    expect(
      execFileSync('bash', ['-c', RUNTIME_REFRESH_SCRIPT], {
        env: { PATH: process.env.PATH, ORCA_ROOT: root, RT: '0'.repeat(64), WANT: COMMIT, SHA: b.sha, URL: `file://${b.path}` },
        encoding: 'utf8'
      }).trim()
    ).toBe(`skip_runtime ${OLD}`)
    expect(readFileSync(join(root, 'runtime/orcad/SOURCE_COMMIT'), 'utf8')).toBe(OLD)
  })

  it('does nothing when the image is already current', () => {
    const root = vm(COMMIT)
    expect(run(root, { WANT: COMMIT, SHA: 'x', URL: 'file:///nope' })).toBe(`current ${COMMIT}`)
  })
})
