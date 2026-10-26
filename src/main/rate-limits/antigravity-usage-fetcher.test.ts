import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from './antigravity-usage-fetcher'
import { ANTIGRAVITY_USAGE_ARGS, ANTIGRAVITY_VERSION_ARGS } from './antigravity-usage-command'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { hostShellEnvironmentMock } = vi.hoisted(() => ({
  hostShellEnvironmentMock: vi.fn(async () => ({ PATH: '/usr/bin' }))
}))

vi.mock('../runtime/structured-agent-shell-environment', () => ({
  hostShellEnvironment: hostShellEnvironmentMock
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

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    resetAntigravityUsageSupportForTests()
  })

  it('publishes the CLI reading as Antigravity usage', async () => {
    const result = await harness({ result: processResult({ stdout: USAGE_ENVELOPE }) }).fetch()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('antigravity')
    expect(result.error).toBeNull()
    expect(result.weekly).toMatchObject({ usedPercent: 60, windowMinutes: 10_080 })
    expect(result.buckets).toEqual([
      {
        name: 'Gemini Models',
        group: 'Gemini Models',
        windowName: 'Weekly Limit Remaining',
        usedPercent: 60,
        windowMinutes: 10_080,
        resetsAt: new Date('2026-10-07T08:08:35Z').getTime(),
        resetDescription: null
      }
    ])
    expect(result.usageMetadata).toMatchObject({
      source: 'cli',
      credentialSource: 'antigravity-cli'
    })
  })

  it('never publishes the agy bucket id to the renderer', async () => {
    const result = await harness({ result: processResult({ stdout: USAGE_ENVELOPE }) }).fetch()

    for (const bucket of result.buckets ?? []) {
      expect(bucket).not.toHaveProperty('id')
    }
  })

  it('probes the version, then runs the quota read with the resolved path and login-shell env', async () => {
    const loginShellEnv = { PATH: '/Users/x/.local/bin:/usr/bin' }
    const h = harness({ result: processResult({ stdout: USAGE_ENVELOPE }), env: loginShellEnv })
    await h.fetch()

    // Login PATH finds ~/.local/bin; disabling updates prevents Windows console flashes.
    const probeEnv = { PATH: '/Users/x/.local/bin:/usr/bin', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
    expect(h.runCommand).toHaveBeenCalledTimes(2)
    const [versionSpec, usageSpec] = h.runCommand.mock.calls.map(([spec]) => spec)
    expect(versionSpec.args).toEqual(ANTIGRAVITY_VERSION_ARGS)
    expect(versionSpec.env).toEqual(probeEnv)
    expect(usageSpec.program).toBe('/Users/x/.local/bin/agy')
    expect(usageSpec.args).toEqual(ANTIGRAVITY_USAGE_ARGS)
    expect(usageSpec.env).toEqual(probeEnv)
    expect(usageSpec.timeoutMs).toBeGreaterThan(0)
    expect(h.resolveCommand).toHaveBeenCalledWith('agy', { platform: 'darwin', env: probeEnv })
    // The login-shell env is a shared cache entry; the probe must not write into it.
    expect(loginShellEnv).toEqual({ PATH: '/Users/x/.local/bin:/usr/bin' })
  })

  it('looks agy up in the env agent launches use, so a Git Bash login PATH cannot hide it', async () => {
    // Why: Git Bash's login PATH is /c/...:/usr/bin, which win32 lookup cannot read (#31459).
    const launchEnv = { PATH: '/c/Users/x/bin:/usr/bin;C:\\Users\\x\\AppData\\Local\\agy\\bin' }
    hostShellEnvironmentMock.mockResolvedValueOnce(launchEnv)
    const resolveCommand = vi.fn().mockResolvedValue(null)
    await fetchAntigravityRateLimits({ resolveCommand, platform: 'win32' })

    expect(resolveCommand).toHaveBeenCalledWith('agy', {
      platform: 'win32',
      env: { ...launchEnv, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
    })
  })

  it('reports an absent CLI as unavailable and never spawns', async () => {
    const h = harness({ program: null })
    const result = await h.fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(result.error).toContain('was not found on this machine')
    expect(h.runCommand).not.toHaveBeenCalled()
  })

  it('reports a signed-out account as unavailable, not as a failed refresh', async () => {
    const result = await harness({
      // agy may exit zero for signed-out diagnostics.
      result: processResult({ stderr: 'You are not logged into Antigravity.' })
    }).fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.error).toContain('Sign in with `agy`')
  })

  it('reports an auth failure on stderr as sign-in guidance, not as a broken read', async () => {
    // Nonzero auth failures still need sign-in guidance.
    const result = await harness({
      result: processResult({ code: 1, stderr: 'Not authenticated. Run agy login.' })
    }).fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.error).toContain('Sign in with `agy`')
  })

  it('reports a bare "Not authenticated." failure on stderr as sign-in guidance', async () => {
    const result = await harness({
      result: processResult({ code: 1, stderr: 'Not authenticated.\n' })
    }).fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.error).toContain('Sign in with `agy`')
  })

  it('does not classify non-auth stderr as signed-out on non-zero exit', async () => {
    // Incidental auth-like words must not trigger credential guidance.
    const result = await harness({
      result: processResult({
        code: 1,
        stderr: 'Failed to contact https://oauth2.googleapis.com/token: connection refused'
      })
    }).fetch()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.error).toContain('did not report a quota (exit 1)')
  })

  it('reports a timeout as its own failure kind', async () => {
    const result = await harness({ result: processResult({ timedOut: true }) }).fetch()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('did not answer in time')
  })

  it('cools down a read that reached agy\u2019s browser sign-in', async () => {
    // Why pinned: agy 1.4.2 opens this OAuth page and waits 60 s, so Orca's 30 s kill lands first (#26484).
    const result = await harness({
      result: processResult({
        timedOut: true,
        stderr:
          'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?...\n\nWaiting for authentication (timeout 60s)...\n'
      })
    }).fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.usageMetadata?.retryAtMs).toBe(1_700_000_000_000 + 60 * 60 * 1000)
  })

  it('keeps the reading when the browser sign-in completes within the read', async () => {
    const result = await harness({
      result: processResult({
        stdout: USAGE_ENVELOPE,
        stderr: 'Authentication required. Please visit the URL to log in:\n'
      })
    }).fetch()

    expect(result.status).toBe('ok')
    expect(result.usageMetadata?.retryAtMs).toBeUndefined()
  })

  it('does not cool down a signed-out read that fails fast without a browser', async () => {
    const result = await harness({
      result: processResult({
        code: 1,
        stderr: "Error: authentication required. Run 'agy' to log in, then retry.\n"
      })
    }).fetch()

    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.usageMetadata?.retryAtMs).toBeUndefined()
  })

  it('reports an unreadable payload as a parse failure carrying the exit code', async () => {
    const result = await harness({
      result: processResult({ code: 2, stdout: 'unknown command /usage' })
    }).fetch()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.error).toContain('exit 2')
  })

  it('does not blame the exit code when agy exited cleanly with no payload', async () => {
    const result = await harness({ result: processResult({ code: 0, stdout: '' }) }).fetch()

    expect(result.status).toBe('error')
    expect(result.error).not.toContain('exit')
  })

  it('reports a spawn failure instead of rejecting the cycle', async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error('EACCES'))
    const result = await harness({ runCommand }).fetch()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(result.error).toContain('EACCES')
  })

  it('never reports quota from a successful read as stale session data', async () => {
    const result = await harness({ result: processResult({ stdout: USAGE_ENVELOPE }) }).fetch()

    // This tier meters weekly pools, not the Gemini mirror's 60-minute per-model window (#22511).
    expect(result.session).toBeNull()
    expect(result.weekly).not.toBeNull()
  })
})

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

  it('reports the quota read as unavailable instead of as a parse failure', async () => {
    const result = await harness({
      result: processResult({ stdout: MODEL_TURN_ENVELOPE })
    }).fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('answers `/usage` as a prompt')
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

  it('does not latch when the usage payload parsed, whatever else the envelope says', async () => {
    const h = harness({
      result: processResult({ stdout: `${USAGE_ENVELOPE}\n${MODEL_TURN_ENVELOPE}` })
    })
    const first = await h.fetch()
    const second = await h.fetch()

    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    expect(h.runCommand).toHaveBeenCalledTimes(4)
  })

  it('does not latch on an empty or unparsable answer', async () => {
    const h = harness({ result: processResult({ code: 2, stdout: 'unknown flag' }) })
    const first = await h.fetch()
    const second = await h.fetch()

    expect(first.status).toBe('error')
    expect(second.status).toBe('error')
    expect(h.runCommand).toHaveBeenCalledTimes(4)
  })
})

describe('the agy version gate', () => {
  beforeEach(() => {
    resetAntigravityUsageSupportForTests()
  })

  it('never runs the quota read below the floor', async () => {
    const h = harness({
      versionResult: processResult({ stdout: 'agy version 1.1.10\n' }),
      result: processResult({ stdout: USAGE_ENVELOPE })
    })
    const result = await h.fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('needs agy 1.1.11 or newer (found 1.1.10)')
    // Below the version floor /usage spends a model turn; never run it.
    expect(h.runCommand).toHaveBeenCalledTimes(1)
    expect(h.runCommand.mock.calls[0]![0].args).toEqual(ANTIGRAVITY_VERSION_ARGS)
  })

  it('holds a prerelease below the floor', async () => {
    // Release candidates below the stable floor must not reach a billable read.
    const h = harness({ versionResult: processResult({ stdout: 'agy version 1.1.11-rc.1\n' }) })
    const result = await h.fetch()

    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('found 1.1.11-rc.1')
    expect(h.runCommand).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a garbled version line', processResult({ stdout: 'agy version unknown\n' })],
    ['a failed version probe', processResult({ code: 1, stderr: 'boom' })]
  ])('reports %s instead of guessing', async (_label, versionResult) => {
    const h = harness({ versionResult })
    const result = await h.fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('version could not be read')
    expect(h.runCommand).toHaveBeenCalledTimes(1)
  })

  it('runs the quota read at exactly the floor', async () => {
    const h = harness({
      versionResult: processResult({ stdout: 'agy version 1.1.11\n' }),
      result: processResult({ stdout: USAGE_ENVELOPE })
    })
    const result = await h.fetch()

    expect(result.status).toBe('ok')
    expect(h.runCommand).toHaveBeenCalledTimes(2)
  })

  it('reads the version from stderr if stdout is empty on exit 0', async () => {
    const h = harness({
      versionResult: processResult({ stdout: '', stderr: 'agy version 1.1.11\n' }),
      result: processResult({ stdout: USAGE_ENVELOPE })
    })
    const result = await h.fetch()

    expect(result.status).toBe('ok')
    expect(h.runCommand).toHaveBeenCalledTimes(2)
  })
})

describe('quota read safety and diagnostic precedence', () => {
  beforeEach(() => resetAntigravityUsageSupportForTests())

  it.each([
    processResult({ stdout: '1.2.14', timedOut: true }),
    processResult({ stdout: '1.2.14', signal: 'SIGTERM' }),
    processResult({ stdout: '1.2.14', code: 1 })
  ])('does not read quota after an unsuccessful version probe: %j', async (versionResult) => {
    const h = harness({ versionResult })
    const result = await h.fetch()
    expect(result.status).toBe('unavailable')
    expect(h.runCommand).toHaveBeenCalledTimes(1)
  })

  it('accepts a quota reading ahead of unrelated auth diagnostics', async () => {
    const result = await harness({
      result: processResult({
        stdout: USAGE_ENVELOPE,
        stderr: 'Not authenticated. Run agy login.'
      })
    }).fetch()
    expect(result.status).toBe('ok')
  })

  it('latches a model turn ahead of authentication guidance', async () => {
    const h = harness({
      result: processResult({ stdout: MODEL_TURN_ENVELOPE, stderr: 'not logged into antigravity' })
    })
    expect((await h.fetch()).error).toContain('answers `/usage` as a prompt')
    await h.fetch()
    expect(h.runCommand).toHaveBeenCalledTimes(2)
  })

  it('prefers a structured quota failure over conflicting sign-in wording', async () => {
    const result = await harness({
      result: processResult({
        stderr: 'not logged in\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}'
      })
    }).fetch()
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.error).not.toContain('Sign in')
  })

  it('rechecks the version after an in-session CLI upgrade', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(processResult({ stdout: '1.1.10' }))
      .mockResolvedValueOnce(processResult({ stdout: '1.2.14' }))
      .mockResolvedValueOnce(processResult({ stdout: USAGE_ENVELOPE }))
    const h = harness({ runCommand })
    expect((await h.fetch()).status).toBe('unavailable')
    expect((await h.fetch()).status).toBe('ok')
    expect(runCommand).toHaveBeenCalledTimes(3)
  })
})
