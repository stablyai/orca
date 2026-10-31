import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { fetchMuseRateLimits } from './muse-usage-fetcher'

const HELP =
  'Usage: muse [OPTIONS] [PROMPT]\n\nCommands:\n  usage            Show your subscription allowance\n  init             Initialize a project\n\nOptions:\n  --help Print help\n'
const USAGE = JSON.stringify({
  schemaVersion: 1,
  allowance: {
    window: { usedPercent: 35, resetsAtMs: 1_900_000_000_000 }
  }
})

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function harness(
  overrides: { help?: ProcessResult; usage?: ProcessResult; program?: string | null } = {}
) {
  const runCommand = vi
    .fn<typeof runProcess>()
    .mockImplementation(async ({ args }) =>
      args?.[0] === '--help'
        ? (overrides.help ?? result({ stdout: HELP }))
        : (overrides.usage ?? result({ stdout: USAGE }))
    )
  const environment = { PATH: '/opt/muse/bin', MUSE_NO_AUTO_UPDATE: '0' }
  const resolveCommand = vi
    .fn()
    .mockResolvedValue('program' in overrides ? overrides.program : '/opt/muse/bin/muse')
  const options = {
    runCommand,
    resolveCommand,
    resolveEnvironment: async () => environment,
    platform: 'linux' as const,
    now: () => 1_800_000_000_000
  }
  return {
    runCommand,
    resolveCommand,
    options,
    environment,
    fetch: () => fetchMuseRateLimits(options)
  }
}

describe('Muse CLI quota read', () => {
  it('checks command support before a bounded quota read in the host environment', async () => {
    const h = harness()
    const reading = await h.fetch()

    expect(reading).toMatchObject({
      status: 'ok',
      session: { usedPercent: 35, windowMinutes: 300 }
    })
    expect(h.runCommand.mock.calls.map(([spec]) => spec.args)).toEqual([
      ['--help'],
      ['usage', '--json']
    ])
    expect(h.resolveCommand).toHaveBeenCalledWith('muse', {
      platform: 'linux',
      env: { PATH: '/opt/muse/bin', MUSE_NO_AUTO_UPDATE: '1' },
      cwd: tmpdir()
    })
    for (const [spec] of h.runCommand.mock.calls) {
      expect(spec).toMatchObject({
        program: '/opt/muse/bin/muse',
        env: { MUSE_NO_AUTO_UPDATE: '1' },
        maxOutputBytes: 65_536
      })
      expect(spec.timeoutMs).toBeGreaterThan(0)
      expect(spec.cwd).toBeDefined()
      expect(spec.input).toBeUndefined()
    }
    expect(h.environment.MUSE_NO_AUTO_UPDATE).toBe('0')
  })

  it('uses the neutral process directory for Windows command resolution too', async () => {
    const h = harness()
    await fetchMuseRateLimits({ ...h.options, platform: 'win32' })

    expect(h.resolveCommand).toHaveBeenCalledWith('muse', {
      platform: 'win32',
      env: { PATH: '/opt/muse/bin', MUSE_NO_AUTO_UPDATE: '1' },
      cwd: tmpdir()
    })
    expect(h.runCommand.mock.calls[0]?.[0].cwd).toBe(tmpdir())
  })

  it.each([
    'Usage: muse [prompt]\nOptions:\n  --help Print help',
    'Usage: muse [prompt]\n\nExamples:\n  usage            Show your subscription allowance',
    'Commands:\n  login            Sign in\n\nOptions:\n  usage            Send a prompt'
  ])('never tries an unadvertised usage subcommand (%s)', async (help) => {
    const h = harness({ help: result({ stdout: help }) })
    const reading = await h.fetch()

    expect(reading).toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
    expect(h.runCommand.mock.calls.map(([spec]) => spec.args)).toEqual([['--help']])
  })

  it.each([
    result({ code: 1, stderr: 'failed help read secret marker' }),
    result({ stdout: HELP, timedOut: true }),
    result({ stdout: HELP, signal: 'SIGTERM' }),
    result({ stdout: HELP, outputTruncated: true })
  ])('treats an incomplete support check as a transient error (%j)', async (help) => {
    const h = harness({ help })
    const reading = await h.fetch()

    expect(reading).toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
    expect(reading.error).not.toContain('Update')
    expect(reading.error).not.toContain('secret marker')
    expect(h.runCommand.mock.calls.map(([spec]) => spec.args)).toEqual([['--help']])
  })

  it('does not spawn when the CLI is absent', async () => {
    const h = harness({ program: null })
    expect(await h.fetch()).toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'cli-unavailable' }
    })
    expect(h.runCommand).not.toHaveBeenCalled()
  })

  it('reports signed-out diagnostics without exposing command output', async () => {
    const h = harness({
      usage: result({ code: 1, stderr: 'Not logged in: run `muse login` (secret marker)' })
    })
    const reading = await h.fetch()

    expect(reading).toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials' }
    })
    expect(reading.error).not.toContain('secret marker')
  })

  it.each([
    { usage: result({ code: 1, stderr: 'HTTP 503 token=secret' }), kind: 'server' },
    { usage: result({ code: 1, stderr: 'Failed to refresh catalog index' }), kind: 'server' },
    { usage: result({ code: 1, stderr: 'Invalid design input from upstream' }), kind: 'server' },
    {
      usage: result({ code: 1, stderr: 'Proxy authentication required (HTTP 407)' }),
      kind: 'server'
    },
    { usage: result({ stdout: 'not JSON' }), kind: 'parse' },
    { usage: result({ timedOut: true }), kind: 'usage-unavailable' },
    { usage: result({ stdout: USAGE, outputTruncated: true }), kind: 'usage-unavailable' }
  ])('distinguishes unsuccessful reads (%j)', async ({ usage, kind }) => {
    const reading = await harness({ usage }).fetch()
    expect(reading).toMatchObject({
      status: 'error',
      session: null,
      usageMetadata: { failureKind: kind }
    })
    expect(reading.error).not.toContain('secret')
  })

  it('does not run a quota read when cancellation interrupts the help check', async () => {
    const h = harness()
    const controller = new AbortController()
    h.runCommand.mockImplementationOnce(async ({ signal }) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      return result({ stdout: HELP })
    })

    const reading = await fetchMuseRateLimits({ ...h.options, signal: controller.signal })

    expect(reading.status).toBe('error')
    expect(h.runCommand).toHaveBeenCalledTimes(1)
  })

  it('passes cancellation to the quota process and discards its result after abort', async () => {
    const h = harness()
    const controller = new AbortController()
    h.runCommand
      .mockImplementationOnce(async () => result({ stdout: HELP }))
      .mockImplementationOnce(async ({ signal }) => {
        expect(signal).toBe(controller.signal)
        controller.abort()
        return result({ stdout: USAGE })
      })

    const reading = await fetchMuseRateLimits({ ...h.options, signal: controller.signal })

    expect(reading.status).toBe('error')
    expect(reading.session).toBeNull()
  })
})
