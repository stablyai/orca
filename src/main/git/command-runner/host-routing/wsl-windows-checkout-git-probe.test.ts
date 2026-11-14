import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslResult } from '../../../wsl/execution/wsl-runner'
import {
  pendingWslWindowsCheckoutGitConfig,
  resetWslWindowsCheckoutProbesForTests,
  type HostGitResult,
  type WslWindowsCheckoutProbeDeps
} from './wsl-windows-checkout-git-probe'
import {
  resetWslWindowsCheckoutGitConfigForTests,
  withWslWindowsCheckoutGitConfig
} from './wsl-windows-checkout-git-config'
import {
  HOST_CONFIG_SYSTEM_AUTOCRLF,
  PLAIN_WINDOWS_CLONE_SAMPLE
} from './wsl-windows-checkout-line-endings.test-fixture'

afterEach(() => {
  resetWslWindowsCheckoutGitConfigForTests()
  resetWslWindowsCheckoutProbesForTests()
})

const CWD = String.raw`C:\Users\dev\repo`
const READ = ['status', '--porcelain=v2']

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
  it('stops waiting when the command aborts', async () => {
    const { run } = harness({ runHostGit: vi.fn(() => new Promise<HostGitResult>(() => {})) })
    const controller = new AbortController()
    const waiting = run(READ, controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })
})
