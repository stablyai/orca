import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from './antigravity-usage-fetcher'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { hostShellEnvironmentMock } = vi.hoisted(() => ({
  hostShellEnvironmentMock: vi.fn(async () => ({ PATH: '/usr/bin' }))
}))

vi.mock('../runtime/agent-session/environment/structured-agent-shell-environment', () => ({
  hostShellEnvironment: hostShellEnvironmentMock
}))
void JSON.stringify({
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
