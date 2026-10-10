import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readCodexCliInstallation,
  readCodexCliInstallationEvidence
} from './codex-cli-installation'
import { CodexCliInstallationCache } from './codex-cli-installation-cache'
import { codexCliInstallation } from '../../shared/codex-cli-installation'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', async (original) => ({
  ...(await original<object>()),
  runProcess
}))

const roots: string[] = []
async function binary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-installation-test-'))
  roots.push(root)
  const file = join(root, 'codex')
  await writeFile(file, 'fake binary; never executed')
  return file
}
function prints(stdout: string, timedOut = false): void {
  runProcess.mockResolvedValue({ code: 0, stdout, stderr: '', timedOut })
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  runProcess.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex binary version cache', () => {
  it('shares concurrent probes and caches the version for ordinary starts', async () => {
    const program = await binary()
    prints('codex-cli 0.136.0')
    const input = { program, env: { PATH: '/launch/path' } }
    const results = await Promise.all([
      readCodexCliInstallation(input),
      readCodexCliInstallation(input)
    ])
    expect(results.every((result) => result.status === 'ready')).toBe(true)
    await readCodexCliInstallation(input)
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program,
        env: input.env,
        args: ['--version'],
        timeoutMs: 5_000,
        maxOutputBytes: 4_096
      })
    )
  })

  it('rechecks an updated binary and a different resolved path', async () => {
    const program = await binary()
    prints('codex-cli 0.135.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('unsupported')
    await writeFile(program, 'updated fake binary of a different size')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    await utimes(program, new Date(), new Date(Date.now() + 10_000))
    await readCodexCliInstallation({ program })
    await readCodexCliInstallation({ program: await binary() })
    expect(runProcess).toHaveBeenCalledTimes(4)
  })

  it('allows a timeout, then retries the unchanged binary after the bounded cache expires', async () => {
    const program = await binary()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    prints('codex-cli 0.135.0', true)
    expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    vi.setSystemTime(30_001)
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('notices an npm package update even when the launcher is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-npm-test-'))
    roots.push(root)
    await mkdir(join(root, 'bin'))
    const program = join(root, 'bin', 'codex.js')
    await writeFile(program, 'unchanged npm launcher; never executed')
    await writeFile(join(root, 'package.json'), '{"version":"0.135.0"}')
    prints('codex-cli 0.135.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('unsupported')
    await writeFile(join(root, 'package.json'), '{"version":"0.136.0","updated":true}')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('proves a missing binary from the filesystem and allows an installed binary with a broken interpreter', async () => {
    const program = await binary()
    expect((await readCodexCliInstallation({ program: join(program, 'missing') })).status).toBe(
      'unknown'
    )
    expect(
      (await readCodexCliInstallation({ program: join(program, '..', 'missing') })).status
    ).toBe('missing')
    expect(runProcess).not.toHaveBeenCalled()
    runProcess.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    runProcess.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EACCES' }))
    expect((await readCodexCliInstallation({ program: await binary() })).status).toBe('unknown')
  })

  it('isolates hosts and does not let a slow old fingerprint replace a new verdict', async () => {
    const cache = new CodexCliInstallationCache()
    let finish: ((result: ReturnType<typeof codexCliInstallation>) => void) | undefined
    const stale = cache.read(
      'wsl:A',
      'old',
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const fresh = vi.fn(async () => codexCliInstallation(true, '0.136.0'))
    await cache.read('wsl:A', 'new', fresh)
    finish?.(codexCliInstallation(true, '0.135.0'))
    await stale
    expect((await cache.read('wsl:A', 'new', fresh)).status).toBe('ready')
    await cache.read('wsl:B', 'new', fresh)
    await cache.read('ssh:A', 'new', fresh)
    expect(fresh).toHaveBeenCalledTimes(3)
  })

  it('rechecks an unchanged wrapper in both upgrade and downgrade directions', async () => {
    const program = await binary()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    prints('company-wrapper 0.1.0\ncodex-cli 0.135.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('unsupported')
    prints('company-wrapper 0.1.0\ncodex-cli 0.136.0')
    vi.setSystemTime(30_001)
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    prints('company-wrapper 0.1.0\ncodex-cli 0.135.0')
    vi.setSystemTime(60_002)
    expect((await readCodexCliInstallation({ program })).status).toBe('unsupported')
    expect(runProcess).toHaveBeenCalledTimes(3)
  })

  it('scopes a wrapper verdict to its directory and effective environment', async () => {
    const program = await binary()
    prints('codex-cli 0.135.0')
    await readCodexCliInstallation({ program, cwd: tmpdir(), env: { CODEX_SELECTION: 'old' } })
    prints('codex-cli 0.136.0')
    const cwd = join(program, '..', 'workspace')
    await mkdir(cwd)
    const first = { program, cwd, env: { CODEX_SELECTION: 'old' } }
    expect((await readCodexCliInstallation(first)).status).toBe('ready')
    prints('codex-cli 0.135.0')
    expect(
      (await readCodexCliInstallation({ ...first, env: { CODEX_SELECTION: 'new' } })).status
    ).toBe('unsupported')
    expect(runProcess).toHaveBeenCalledTimes(3)
  })

  it("fingerprints an npm launcher's native vendor binary when its package and launcher stay unchanged", async () => {
    const program = await binary()
    const root = join(program, '..')
    const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    const system =
      process.platform === 'darwin'
        ? 'apple-darwin'
        : process.platform === 'win32'
          ? 'pc-windows-msvc'
          : 'unknown-linux-musl'
    const packageRoot = join(root, 'package')
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    const launcher = join(packageRoot, 'bin', 'codex.js')
    await writeFile(launcher, 'unchanged launcher')
    await writeFile(join(packageRoot, 'package.json'), '{"name":"@openai/codex"}')
    const nativeDirectory = join(packageRoot, 'vendor', `${cpu}-${system}`, 'codex')
    await mkdir(nativeDirectory, { recursive: true })
    const native = join(nativeDirectory, process.platform === 'win32' ? 'codex.exe' : 'codex')
    await writeFile(native, 'old binary')
    prints('codex-cli 0.135.0')
    await readCodexCliInstallation({ program: launcher })
    await writeFile(native, 'updated binary of a different size')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program: launcher })).status).toBe('ready')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })
  it('returns the original host expiry on cached reads and an opaque identity for each configuration', async () => {
    const program = await binary()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    prints('codex-cli 0.135.0')
    const input = { program, env: { SELECTION: 'private-test-value' } }
    const first = await readCodexCliInstallationEvidence(input)
    expect(first.expiresAt).toBe(30_000)
    vi.setSystemTime(29_999)
    const cached = await readCodexCliInstallationEvidence(input)
    expect(cached.expiresAt).toBe(first.expiresAt)
    expect(cached.configurationId).toBe(first.configurationId)
    expect(cached.configurationId).toMatch(/^[a-f0-9]{64}$/)
    const changed = await readCodexCliInstallationEvidence({
      ...input,
      env: { SELECTION: 'changed' }
    })
    expect(changed.configurationId).not.toBe(first.configurationId)
    prints('codex-cli 0.136.0')
    vi.setSystemTime(30_000)
    const updated = await readCodexCliInstallationEvidence(input)
    expect(updated.installation.status).toBe('ready')
    expect(updated.expiresAt).toBe(60_000)
  })
})
