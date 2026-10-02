import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from './antigravity-usage-fetcher'
import { ANTIGRAVITY_USAGE_ARGS, ANTIGRAVITY_VERSION_ARGS } from './antigravity-usage-command'
import type { ProcessResult } from '../../shared/child-process/process-spec'

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
  // Why the per-call split: the fetcher probes `--version` before the quota read, and a fixture
  // that answers both alike either fakes a version line into `/usage` or a usage envelope into the
  // version probe.
  const runCommand =
    options.runCommand ??
    vi
      .fn()
      .mockImplementation(async (spec: { args?: readonly string[] }) =>
        spec.args?.[0] === '--version'
          ? (options.versionResult ?? processResult({ stdout: 'agy version 1.2.11\n' }))
          : (options.result ?? processResult())
      )
  // Why the `in` check and not `??`: an explicit `program: null` is the absent-CLI case.
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
    const h = harness({ result: processResult({ stdout: USAGE_ENVELOPE }) })
    await h.fetch()

    expect(h.runCommand).toHaveBeenCalledTimes(2)
    expect(h.runCommand.mock.calls[0]![0].args).toEqual(ANTIGRAVITY_VERSION_ARGS)
    const spec = h.runCommand.mock.calls[1]![0]
    expect(spec.program).toBe('/Users/x/.local/bin/agy')
    expect(spec.args).toEqual(ANTIGRAVITY_USAGE_ARGS)
    // Why the login-shell PATH: agy installs to ~/.local/bin, which Electron's inherited PATH omits.
    expect(spec.env).toEqual({ PATH: '/Users/x/.local/bin:/usr/bin' })
    expect(spec.timeoutMs).toBeGreaterThan(0)
    expect(h.resolveCommand).toHaveBeenCalledWith('agy', {
      platform: 'darwin',
      env: { PATH: '/Users/x/.local/bin:/usr/bin' }
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
      // agy exits 0 and prints this rather than an envelope.
      result: processResult({ stderr: 'You are not logged into Antigravity.' })
    }).fetch()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.error).toContain('Sign in with `agy`')
  })

  it('reports an auth failure on stderr as sign-in guidance, not as a broken read', async () => {
    // Why pinned: the other shape of "signed out" — a non-zero exit with an auth diagnostic — used
    // to land in the parse-failure branch as a generic refresh error.
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
    // Why pinned: stderr containing unrelated words like "oauth" or "author" must not be misclassified
    // as missing-credentials.
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

    // Why: this tier meters no 5h pool. The Gemini mirror it replaces filled `session` from a
    // 60-minute per-model window and left `weekly` null — exactly backwards (#22511).
    expect(result.session).toBeNull()
    expect(result.weekly).not.toBeNull()
  })
})

/**
 * Captured when agy treated `/usage` as a prompt instead of a command: a conversation was started,
 * a turn was spent, and the account answered RESOURCE_EXHAUSTED. This is the exact shape the
 * unsupported latch has to recognise.
 */
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

    // Why: the evidence costs a turn of the user's quota, so rediscovering it on a 15-minute
    // cadence would keep paying for the same answer.
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

    // Why: a transient failure is not evidence that the command is unsupported.
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
    // Why the assertion: below the floor `/usage` is a billed model turn, so it must not run at all.
    expect(h.runCommand).toHaveBeenCalledTimes(1)
    expect(h.runCommand.mock.calls[0]![0].args).toEqual(ANTIGRAVITY_VERSION_ARGS)
  })

  it('holds a prerelease below the floor', async () => {
    // Why pinned: `1.1.11-rc.1` sorts below stable `1.1.11`; reading the core alone would let a
    // release candidate spawn the billable read early.
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
