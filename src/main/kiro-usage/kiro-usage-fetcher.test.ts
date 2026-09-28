import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchKiroUsage } from './kiro-usage-fetcher'
import { CapabilityProbeCache } from '../../shared/capability-probe-cache'
import type { ProcessResult } from '../../shared/child-process/run-process'

const OK_OUTPUT =
  'One or more mcp server did not load correctly.\n' +
  'Estimated Usage | resets on 2026-10-01 | KIRO PRO\n' +
  'Credits (132.35 of 1000 covered in plan)\n████ 13.2%\n'

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

const installedProgram = '/usr/local/bin/kiro-cli'
const noSleep = () => Promise.resolve()

const UNKNOWN_FLAG_STDERR =
  "error: unexpected argument '--agent-engine' found\n\nUsage: kiro-cli-chat chat [INPUT]\n"

// v3 announces itself before answering; seeing it means /usage reached the model.
const V3_OUTPUT =
  '[INFO] kas.server.starting {"product":"KAS (Kiro Agent Server)","version":"0.66.0"}\n' +
  "I don't have a `/usage` command or a way to look up account usage.\n"

// Fresh per test so one test's unsupported verdict cannot leak into the next.
let engineCapabilities: CapabilityProbeCache<string>
beforeEach(() => {
  engineCapabilities = new CapabilityProbeCache<string>(30 * 60_000)
})

function fetchUsage(options: Parameters<typeof fetchKiroUsage>[0] = {}) {
  return fetchKiroUsage({ sleep: noSleep, engineCapabilities, ...options })
}

describe('fetchKiroUsage', () => {
  it('returns unavailable (no retries) when kiro-cli is not installed', async () => {
    const run = vi.fn()
    const snap = await fetchUsage({ program: 'kiro-cli', run })
    expect(snap.status).toBe('unavailable')
    expect(snap.error).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('parses the meter on the first successful attempt', async () => {
    const run = vi.fn().mockResolvedValue(processResult({ stdout: OK_OUTPUT }))
    const snap = await fetchUsage({ program: installedProgram, run })
    expect(snap.status).toBe('ok')
    expect(snap.quota?.usedPercent).toBe(13.2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries a transient no-meter result then succeeds', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(processResult({ stdout: 'mcp warning only' }))
      .mockResolvedValueOnce(processResult({ stdout: OK_OUTPUT }))
    const snap = await fetchUsage({ program: installedProgram, run })
    expect(snap.status).toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries a timeout and then a nonzero exit before erroring', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(processResult({ timedOut: true, code: null }))
      .mockResolvedValueOnce(processResult({ code: 1, stderr: 'boom' }))
      .mockResolvedValueOnce(processResult({ code: 1, stderr: 'boom' }))
    const snap = await fetchUsage({ program: installedProgram, run })
    expect(snap.status).toBe('error')
    expect(snap.quota).toBeNull()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('treats a spawn rejection on an installed binary as a retryable error, not unavailable', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn EAGAIN'))
    const snap = await fetchUsage({ program: installedProgram, run })
    expect(snap.status).toBe('error')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('stops retrying once aborted', async () => {
    const controller = new AbortController()
    const run = vi.fn().mockImplementation(async () => {
      controller.abort()
      return processResult({ stdout: 'no meter' })
    })
    const snap = await fetchUsage({ program: installedProgram, run, signal: controller.signal })
    expect(snap.status).toBe('error')
    // First attempt ran; the abort short-circuits before a second.
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('pins the read to the v2 engine so /usage stays a slash command', async () => {
    const run = vi.fn().mockResolvedValue(processResult({ stdout: OK_OUTPUT }))
    await fetchUsage({ program: installedProgram, run })
    expect(run.mock.calls[0]?.[0].args).toEqual([
      'chat',
      '--agent-engine',
      'v2',
      '--no-interactive',
      '/usage'
    ])
  })

  it('drops the engine flag on a CLI too old to know it, then remembers', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(processResult({ code: 2, stderr: UNKNOWN_FLAG_STDERR }))
      .mockResolvedValue(processResult({ stdout: OK_OUTPUT }))

    const first = await fetchUsage({ program: installedProgram, run })
    expect(first.status).toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]?.[0].args).toEqual(['chat', '--no-interactive', '/usage'])

    // A remembered verdict must not re-probe the flag on the next read.
    run.mockClear()
    const second = await fetchUsage({ program: installedProgram, run })
    expect(second.status).toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0].args).toEqual(['chat', '--no-interactive', '/usage'])
  })

  it('does not retry once v3 answered /usage as a prompt, so it bills only once', async () => {
    const run = vi.fn().mockResolvedValue(processResult({ stdout: V3_OUTPUT }))
    const snap = await fetchUsage({ program: installedProgram, run })
    expect(snap.status).toBe('error')
    expect(snap.error).toContain('v3 agent engine')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps a real argument error retryable rather than reading it as a missing flag', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        processResult({ code: 2, stderr: "error: unexpected argument '--tui'" })
      )
      .mockResolvedValueOnce(processResult({ stdout: OK_OUTPUT }))
    const snap = await fetchUsage({ program: installedProgram, run })
    expect(snap.status).toBe('ok')
    expect(run.mock.calls[1]?.[0].args).toContain('--agent-engine')
  })
})
