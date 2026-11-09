import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from './antigravity-usage-fetcher'
import { ANTIGRAVITY_USAGE_ARGS } from './antigravity-usage-command'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { hostShellEnvironmentMock, runWslProcessMock, wslRunningMock, defaultDistroMock } =
  vi.hoisted(() => ({
    hostShellEnvironmentMock: vi.fn(async () => ({ PATH: '/usr/bin' })),
    runWslProcessMock: vi.fn(),
    wslRunningMock: vi.fn(async () => true),
    defaultDistroMock: vi.fn(async (): Promise<string | null | symbol> => 'Ubuntu')
  }))

vi.mock('../../../runtime/agent-session/environment/structured-agent-shell-environment', () => ({
  hostShellEnvironment: hostShellEnvironmentMock
}))
vi.mock('../../../wsl/discovery/wsl-default-distro', () => ({
  resolveWslDefaultDistro: defaultDistroMock,
  UNRESOLVED_WSL_DEFAULT: Symbol('unresolved')
}))
vi.mock('../../../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
vi.mock('../../../wsl/discovery/wsl-background-distro-gate', () => ({
  isWslDistroRunningForBackgroundWork: wslRunningMock
}))

const USAGE_ENVELOPE = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit.',
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.4,
              reset_time: '2026-10-07T08:08:35Z'
            }
          ]
        }
      ]
    }
  }
})

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function harness(
  options: {
    result?: ProcessResult
    versionResult?: ProcessResult
    runCommand?: ReturnType<typeof vi.fn>
    program?: string | null
    env?: NodeJS.ProcessEnv
  } = {}
) {
  // Version and usage probes need distinct payloads.
  const runCommand =
    options.runCommand ??
    vi
      .fn()
      .mockImplementation(async (spec: { args?: readonly string[] }) =>
        spec.args?.[0] === '--version'
          ? (options.versionResult ?? processResult({ stdout: 'agy version 1.2.11\n' }))
          : (options.result ?? processResult())
      )
  // Explicit program: null models an absent CLI.
  const resolveCommand = vi
    .fn()
    .mockResolvedValue('program' in options ? options.program : '/Users/x/.local/bin/agy')
  const resolveEnvironment = vi
    .fn()
    .mockResolvedValue(options.env ?? { PATH: '/Users/x/.local/bin:/usr/bin' })
  return {
    runCommand,
    resolveCommand,
    resolveEnvironment,
    fetch: () =>
      fetchAntigravityRateLimits({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock returns a ProcessResult, which is the whole contract runProcess exposes to this fetcher.
        runCommand: runCommand as never,
        resolveCommand,
        resolveEnvironment,
        platform: 'darwin',
        now: () => 1_700_000_000_000
      })
  }
}

/** Captured billed-turn response when /usage was treated as a prompt; must latch future probes off. */
const MODEL_TURN_ENVELOPE = JSON.stringify({
  conversation_id: '28a5ca91-301f-4050-8efc-9c82c4e64df3',
  status: 'ERROR',
  response: '',
  error: 'Individual quota reached. Please upgrade your subscription to increase your limits.',
  num_turns: 1
})

describe('agy versions that answer /usage as a prompt', () => {
  beforeEach(() => {
    resetAntigravityUsageSupportForTests()
  })

  it('never spawns agy again once a turn was spent', async () => {
    const h = harness({ result: processResult({ stdout: MODEL_TURN_ENVELOPE }) })
    await h.fetch()
    expect(h.runCommand).toHaveBeenCalledTimes(2)

    // Retrying unsupported /usage would spend another model turn on every poll.
    await h.fetch()
    await h.fetch()
    expect(h.runCommand).toHaveBeenCalledTimes(2)
  })
})

describe('a WSL runtime target', () => {
  const ubuntu = { runtime: 'wsl', wslDistro: 'Ubuntu' } as const

  beforeEach(() => {
    resetAntigravityUsageSupportForTests()
    wslRunningMock.mockReset().mockResolvedValue(true)
    defaultDistroMock.mockReset().mockResolvedValue('Ubuntu')
    runWslProcessMock
      .mockReset()
      .mockImplementation(async (spec: { args: readonly string[] }) =>
        spec.args[0] === '--version'
          ? processResult({ stdout: 'agy version 1.2.11\n' })
          : processResult({ stdout: USAGE_ENVELOPE })
      )
  })

  it('reads quota from the agy inside the selected distro, never the host CLI', async () => {
    const h = harness()
    const result = await fetchAntigravityRateLimits({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock returns a ProcessResult, which is the whole contract runProcess exposes to this fetcher.
      runCommand: h.runCommand as never,
      resolveCommand: h.resolveCommand,
      target: ubuntu
    })

    expect(result.status).toBe('ok')
    expect(result.usageMetadata?.authProvenance).toBe('wsl:ubuntu')
    expect(h.runCommand).not.toHaveBeenCalled()
    expect(h.resolveCommand).not.toHaveBeenCalled()
    expect(runWslProcessMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        distro: 'Ubuntu',
        loginPath: 'preferred',
        program: 'agy',
        args: ANTIGRAVITY_USAGE_ARGS,
        env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
      })
    )
  })

  it('reads the default distro WSL reports, not the first one listed', async () => {
    defaultDistroMock.mockResolvedValue('Debian')

    const result = await fetchAntigravityRateLimits({ target: { runtime: 'wsl', wslDistro: null } })

    expect(result.usageMetadata?.authProvenance).toBe('wsl:debian')
    expect(wslRunningMock).toHaveBeenCalledWith('Debian')
    expect(runWslProcessMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ distro: 'Debian' })
    )
  })

  it.each([true, false])(
    'distinguishes a missing CLI from an unresolved login environment: %s',
    async (environmentResolved) => {
      runWslProcessMock.mockResolvedValue({
        ...processResult({ code: 127, stderr: 'agy: not found' }),
        environmentResolved
      })

      const result = await fetchAntigravityRateLimits({ target: ubuntu })

      expect(result.status).toBe(environmentResolved ? 'unavailable' : 'error')
      expect(result.error).toContain(environmentResolved ? 'was not found' : 'login environment')
      expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    }
  )

  it('never starts a stopped distro to read quota', async () => {
    wslRunningMock.mockResolvedValue(false)

    const result = await fetchAntigravityRateLimits({ target: ubuntu })

    expect(result.status).toBe('unavailable')
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('latches a CLI that spent a model turn only in its own runtime', async () => {
    runWslProcessMock.mockImplementation(async (spec: { args: readonly string[] }) =>
      spec.args[0] === '--version'
        ? processResult({ stdout: 'agy version 1.2.11\n' })
        : processResult({ stdout: MODEL_TURN_ENVELOPE })
    )
    await fetchAntigravityRateLimits({ target: ubuntu })

    const host = await harness({ result: processResult({ stdout: USAGE_ENVELOPE }) }).fetch()

    expect(host.status).toBe('ok')
  })
})
