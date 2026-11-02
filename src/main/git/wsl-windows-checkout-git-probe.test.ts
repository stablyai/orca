import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslResult } from '../wsl/wsl-runner'
import {
  pendingWslWindowsCheckoutGitConfig,
  resetWslWindowsCheckoutProbesForTests,
  type HostGitResult,
  type WslWindowsCheckoutProbeDeps
} from './wsl-windows-checkout-git-probe'
import {
  resetWslWindowsCheckoutGitConfigForTests,
  withWslWindowsCheckoutGitConfig,
  WSL_WINDOWS_CHECKOUT_TTL_MS
} from './wsl-windows-checkout-git-config'
import {
  HOST_CONFIG_LOCAL_AUTOCRLF_FALSE,
  HOST_CONFIG_SYSTEM_AUTOCRLF,
  PLAIN_WINDOWS_CLONE_SAMPLE,
  WSL_CLONE_WITH_CRLF_README_SAMPLE
} from './wsl-windows-checkout-line-endings.test-fixture'

afterEach(() => {
  resetWslWindowsCheckoutGitConfigForTests()
  resetWslWindowsCheckoutProbesForTests()
})

const CWD = String.raw`C:\Users\dev\repo`
const READ = ['status', '--porcelain=v2']
const WRITE = ['checkout', '--', 'README.md']

function host(overrides: Partial<HostGitResult> = {}): HostGitResult {
  return { code: 0, stdout: HOST_CONFIG_SYSTEM_AUTOCRLF, stderr: '', timedOut: false, ...overrides }
}

function wsl(overrides: Partial<WslResult> = {}): WslResult {
  return {
    environmentResolved: true,
    code: 0,
    stdout: PLAIN_WINDOWS_CLONE_SAMPLE,
    stderr: '',
    timedOut: false,
    outputTruncated: false,
    ...overrides
  }
}

type HostRunner = NonNullable<WslWindowsCheckoutProbeDeps['runHostGit']>
type WslRunner = NonNullable<WslWindowsCheckoutProbeDeps['runWsl']>
type IdentityReader = NonNullable<WslWindowsCheckoutProbeDeps['checkoutIdentity']>

function harness(
  overrides: { runHostGit?: HostRunner; runWsl?: WslRunner; checkoutIdentity?: IdentityReader } = {}
) {
  const clock = { now: 1_000_000 }
  const deps = {
    platform: 'win32' as const,
    now: () => clock.now,
    runHostGit: vi.fn<HostRunner>(overrides.runHostGit ?? (async () => host())),
    runWsl: vi.fn<WslRunner>(overrides.runWsl ?? (async () => wsl())),
    checkoutIdentity: vi.fn<IdentityReader>(overrides.checkoutIdentity ?? (async () => 'clone-1')),
    admit: vi.fn(async () => ({ queueWaitMs: 0, release: vi.fn() }))
  }
  const run = (args: string[], signal?: AbortSignal) =>
    pendingWslWindowsCheckoutGitConfig(args, { cwd: CWD, wslDistro: 'Ubuntu', signal }, deps)
  const flagged = (args: string[]) =>
    withWslWindowsCheckoutGitConfig(args, CWD, 'Ubuntu', 'win32', clock.now).includes(
      'core.autocrlf=true'
    )
  return { clock, deps, run, flagged }
}

describe('pendingWslWindowsCheckoutGitConfig', () => {
  it('ignores commands that are not WSL git on a Windows drive', () => {
    const { deps } = harness()
    expect(pendingWslWindowsCheckoutGitConfig(READ, { cwd: CWD }, deps)).toBeNull()
    expect(
      pendingWslWindowsCheckoutGitConfig(
        READ,
        { cwd: String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`, wslDistro: 'Ubuntu' },
        deps
      )
    ).toBeNull()
    expect(deps.runHostGit).not.toHaveBeenCalled()
  })

  it('flags the first read from the host answer alone, without waiting for the distro', async () => {
    const { deps, run, flagged } = harness({
      runWsl: vi.fn(() => new Promise<WslResult>(() => {}))
    })
    await run(READ)
    expect(flagged(READ)).toBe(true)
    expect(flagged(WRITE)).toBe(false)
    await vi.waitFor(() => expect(deps.runWsl).toHaveBeenCalledTimes(1))
  })

  it('never samples when host Git would not write CRLF', async () => {
    const { deps, run, flagged } = harness({
      runHostGit: vi.fn(async () => host({ stdout: HOST_CONFIG_LOCAL_AUTOCRLF_FALSE }))
    })
    await run(WRITE)
    expect(flagged(READ)).toBe(false)
    expect(deps.runWsl).not.toHaveBeenCalled()
  })

  it('treats an unset autocrlf (exit 1, quiet) as settled', async () => {
    const { deps, run } = harness({ runHostGit: vi.fn(async () => host({ code: 1, stdout: '' })) })
    await run(READ)
    await run(READ)
    expect(deps.runHostGit).toHaveBeenCalledTimes(1)
  })

  it('waits for a fresh sample before a write and flags it on a Windows checkout', async () => {
    const { run, flagged } = harness()
    await run(WRITE)
    expect(flagged(WRITE)).toBe(true)
  })

  it('does not flag writes on a WSL checkout with one CRLF file', async () => {
    const { run, flagged } = harness({
      runWsl: vi.fn(async () => wsl({ stdout: WSL_CLONE_WITH_CRLF_README_SAMPLE }))
    })
    await run(WRITE)
    expect(flagged(WRITE)).toBe(false)
    expect(flagged(READ)).toBe(false)
  })

  it('treats clipped sample output as inconclusive', async () => {
    const { run, flagged } = harness({ runWsl: vi.fn(async () => wsl({ outputTruncated: true })) })
    await run(WRITE)
    expect(flagged(WRITE)).toBe(false)
  })

  it('re-samples before a write once the answer is stale', async () => {
    const { clock, deps, run, flagged } = harness()
    await run(WRITE)
    clock.now += WSL_WINDOWS_CHECKOUT_TTL_MS
    deps.runWsl.mockResolvedValueOnce(wsl({ stdout: WSL_CLONE_WITH_CRLF_README_SAMPLE }))
    await run(WRITE)
    expect(deps.runWsl).toHaveBeenCalledTimes(2)
    expect(flagged(WRITE)).toBe(false)
  })

  it('re-samples before a write when the checkout was re-cloned at the same path', async () => {
    const { deps, run, flagged } = harness()
    await run(WRITE)
    deps.checkoutIdentity.mockResolvedValue('clone-2')
    deps.runWsl.mockResolvedValueOnce(wsl({ stdout: WSL_CLONE_WITH_CRLF_README_SAMPLE }))
    await run(WRITE)
    expect(deps.runWsl).toHaveBeenCalledTimes(2)
    expect(flagged(WRITE)).toBe(false)
  })

  it('does not trust a joined sample that began before the checkout was replaced', async () => {
    let finishSample: (result: WslResult) => void = () => {}
    const { deps, run, flagged } = harness({
      runWsl: vi.fn(() => new Promise<WslResult>((resolve) => (finishSample = resolve)))
    })
    await run(READ)
    await vi.waitFor(() => expect(deps.runWsl).toHaveBeenCalledTimes(1))
    deps.checkoutIdentity.mockResolvedValue('clone-2')
    const write = run(WRITE)
    await vi.waitFor(() => expect(deps.checkoutIdentity).toHaveBeenCalledTimes(2))
    finishSample(wsl())
    await write
    expect(flagged(WRITE)).toBe(false)
    expect(withWslWindowsCheckoutGitConfig(WRITE, CWD, 'Ubuntu', 'win32', Date.now())).toEqual([
      '-c',
      'core.autocrlf=input',
      ...WRITE
    ])
  })

  it('keeps a sample taken of the checkout that replaced the one the write first saw', async () => {
    const { deps, run, flagged } = harness({ checkoutIdentity: async () => 'clone-2' })
    deps.checkoutIdentity.mockResolvedValueOnce('clone-1')
    await run(WRITE)
    expect(flagged(WRITE)).toBe(true)
  })

  it('refreshes a stale host answer before a write rather than in the background', async () => {
    const { clock, deps, run, flagged } = harness()
    await run(WRITE)
    clock.now += WSL_WINDOWS_CHECKOUT_TTL_MS
    deps.runHostGit.mockResolvedValue(host({ stdout: HOST_CONFIG_LOCAL_AUTOCRLF_FALSE }))
    await run(WRITE)
    expect(deps.runHostGit).toHaveBeenCalledTimes(2)
    expect(flagged(WRITE)).toBe(false)
    expect(flagged(READ)).toBe(false)
  })

  it('never probes for a command that creates another checkout', async () => {
    const { deps, run } = harness()
    await run(['worktree', 'add', '-b', 'feature', String.raw`C:\Users\dev\feature`])
    expect(deps.runHostGit).not.toHaveBeenCalled()
    expect(deps.runWsl).not.toHaveBeenCalled()
  })

  it('caches only a genuine "not a git repository" and backs off other fatal errors', async () => {
    const notRepo = harness({
      runHostGit: vi.fn(async () =>
        host({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any parent)' })
      )
    })
    await notRepo.run(READ)
    await notRepo.run(READ)
    expect(notRepo.deps.runHostGit).toHaveBeenCalledTimes(1)
    resetWslWindowsCheckoutGitConfigForTests()

    const dubious = harness({
      runHostGit: vi.fn(async () =>
        host({ code: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository' })
      )
    })
    await dubious.run(READ)
    expect(dubious.flagged(READ)).toBe(false)
    await dubious.run(READ)
    expect(dubious.deps.runHostGit).toHaveBeenCalledTimes(1)
    dubious.clock.now += 30_000
    dubious.deps.runHostGit.mockResolvedValueOnce(host())
    await dubious.run(READ)
    expect(dubious.flagged(READ)).toBe(true)
  })

  it('backs off a sample that fails for any reason other than "not a git repository"', async () => {
    const { clock, deps, run, flagged } = harness({
      runWsl: vi.fn(async () => wsl({ code: 3, stdout: '', stderr: 'fatal: unable to read index' }))
    })
    await run(WRITE)
    await run(WRITE)
    expect(deps.runWsl).toHaveBeenCalledTimes(1)
    expect(flagged(WRITE)).toBe(false)
    clock.now += 30_000
    await run(WRITE)
    expect(deps.runWsl).toHaveBeenCalledTimes(2)
  })

  it('admits every probe through the git scheduler and shares concurrent probes', async () => {
    const { deps, run } = harness()
    await Promise.all([run(WRITE), run(WRITE), run(READ)])
    expect(deps.runHostGit).toHaveBeenCalledTimes(1)
    expect(deps.runWsl).toHaveBeenCalledTimes(1)
    expect(deps.admit).toHaveBeenCalledTimes(2)
    expect(deps.admit).toHaveBeenCalledWith(expect.objectContaining({ wslDistro: 'Ubuntu' }))
  })

  it('stops waiting when the command aborts', async () => {
    const { run } = harness({ runHostGit: vi.fn(() => new Promise<HostGitResult>(() => {})) })
    const controller = new AbortController()
    const waiting = run(READ, controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })

  it('passes the sample cap and the index-entry scan cap through argv', async () => {
    const { deps, run } = harness()
    await run(WRITE)
    expect(deps.runWsl).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: 'Ubuntu',
        args: ['/mnt/c/Users/dev/repo', '200', '2000'],
        loginPath: 'preferred'
      })
    )
  })
})
