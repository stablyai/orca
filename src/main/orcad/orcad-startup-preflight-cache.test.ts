import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import type * as BundledRuntime from './orcad-bundled-runtime'
import type * as Verdict from './orcad-startup-preflight-verdict'
import { preflightBundledOrcadStartup, reprobeBundledOrcadStartup } from './orcad-profile-preflight'

const fixture = vi.hoisted(() => ({
  readVersion: vi.fn(),
  run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  path: vi.fn<() => string | null>(),
  fingerprint: vi.fn<() => Promise<string | null>>(),
  read: vi.fn(),
  write: vi.fn(),
  forget: vi.fn(),
  claim: vi.fn<() => Promise<boolean>>(),
  clearAbandoned: vi.fn()
}))
vi.mock('./orcad-bundled-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRuntime>()),
  isRunningAsBundledOrcadRuntime: () => true,
  resolveBundledOrcadSlot: () => '/slot'
}))
vi.mock('node:fs/promises', () => ({ readFile: fixture.readVersion }))
vi.mock('@orca/process-host', () => ({ runProcess: fixture.run }))
vi.mock('./orcad-startup-preflight-verdict', async (importOriginal) => ({
  ...(await importOriginal<typeof Verdict>()),
  startupPreflightVerdictPath: fixture.path,
  computeStartupPreflightFingerprint: fixture.fingerprint,
  readStartupPreflightVerdict: fixture.read,
  writeStartupPreflightVerdict: fixture.write,
  forgetStartupPreflightVerdict: fixture.forget,
  claimStartupPreflightSkip: fixture.claim,
  clearAbandonedStartupPreflightClaim: fixture.clearAbandoned
}))

const identity = '0.1.0+aaaaaaaaaaaa'
const fingerprint = 'a'.repeat(64)
const verdictPath = '/slot/.orcad-startup-preflight.json'

function readyResult(nonce: string | undefined): ProcessResult {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    stderr: '',
    stdout: JSON.stringify({
      type: 'orca_profile_state_ready',
      nonce,
      runtime: 'node',
      runtimeVersion: NODE_RUNTIME_PIN.version,
      artifactVersion: identity,
      sqliteVersion: '3.53.2',
      revision: 1
    })
  }
}

function matchingVerdict() {
  return {
    format: 3,
    fingerprint,
    artifactVersion: identity,
    runtimeVersion: NODE_RUNTIME_PIN.version
  }
}

beforeEach(() => {
  vi.spyOn(process, 'versions', 'get').mockReturnValue({
    ...process.versions,
    node: NODE_RUNTIME_PIN.version
  })
  fixture.readVersion.mockResolvedValue(`${identity}\n`)
  fixture.run.mockImplementation(async (spec) => readyResult(spec.args?.[2]))
  fixture.path.mockReturnValue(verdictPath)
  fixture.fingerprint.mockResolvedValue(fingerprint)
  fixture.read.mockResolvedValue(null)
  fixture.write.mockResolvedValue(undefined)
  fixture.forget.mockResolvedValue(undefined)
  fixture.claim.mockResolvedValue(true)
  fixture.clearAbandoned.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('managed slot startup preflight verdict', () => {
  it('skips the probe child when the verdict matches this install and runtime', async () => {
    fixture.read.mockResolvedValue(matchingVerdict())
    await preflightBundledOrcadStartup()
    expect(fixture.run).not.toHaveBeenCalled()
    expect(fixture.forget).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
  })

  it('probes when the previous skipped start never reached readiness', async () => {
    fixture.read.mockResolvedValue(matchingVerdict())
    fixture.claim.mockResolvedValue(false)
    await preflightBundledOrcadStartup()
    expect(fixture.forget).toHaveBeenCalledWith(verdictPath)
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.write).toHaveBeenCalledOnce()
  })

  it('probes and records a verdict on the first start of an install', async () => {
    await preflightBundledOrcadStartup()
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.write).toHaveBeenCalledWith(verdictPath, {
      fingerprint,
      artifactVersion: identity,
      runtimeVersion: NODE_RUNTIME_PIN.version
    })
  })

  it.each([
    ['a changed fingerprint', { fingerprint: 'b'.repeat(64) }],
    ['another artifact version', { artifactVersion: '0.1.0+bbbbbbbbbbbb' }],
    ['another Node runtime', { runtimeVersion: '24.0.0' }]
  ])('re-probes on %s', async (_label, change) => {
    fixture.read.mockResolvedValue({ ...matchingVerdict(), ...change })
    await preflightBundledOrcadStartup()
    expect(fixture.forget).toHaveBeenCalledWith(verdictPath)
    expect(fixture.run).toHaveBeenCalledOnce()
  })

  it('never skips when the fingerprint cannot be computed, and records nothing', async () => {
    fixture.fingerprint.mockResolvedValue(null)
    fixture.read.mockResolvedValue(matchingVerdict())
    await preflightBundledOrcadStartup()
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.write).not.toHaveBeenCalled()
  })

  it('drops the verdict before a probe that fails, and records nothing', async () => {
    fixture.read.mockResolvedValue({ ...matchingVerdict(), fingerprint: 'b'.repeat(64) })
    fixture.run.mockResolvedValue({ ...readyResult(undefined), code: 1, stdout: '' })
    await expect(preflightBundledOrcadStartup()).rejects.toThrow()
    expect(fixture.forget).toHaveBeenCalledWith(verdictPath)
    expect(fixture.forget.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.run.mock.invocationCallOrder[0]
    )
    expect(fixture.write).not.toHaveBeenCalled()
  })

  it('records nothing when the install changed while the probe ran', async () => {
    fixture.fingerprint.mockResolvedValueOnce(fingerprint).mockResolvedValueOnce('c'.repeat(64))
    await preflightBundledOrcadStartup()
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.write).not.toHaveBeenCalled()
  })

  it('keeps probing every start outside a client-managed slot', async () => {
    fixture.path.mockReturnValue(null)
    await preflightBundledOrcadStartup()
    await preflightBundledOrcadStartup()
    expect(fixture.run).toHaveBeenCalledTimes(2)
    expect(fixture.fingerprint).not.toHaveBeenCalled()
    expect(fixture.read).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
  })
  it('clears a dead start’s abandoned claim once a probe passes', async () => {
    await preflightBundledOrcadStartup()
    expect(fixture.clearAbandoned).toHaveBeenCalledWith(verdictPath)
  })

  it('re-probes on demand even with a matching verdict, and never claims a skip', async () => {
    fixture.read.mockResolvedValue(matchingVerdict())
    await reprobeBundledOrcadStartup()
    expect(fixture.claim).not.toHaveBeenCalled()
    expect(fixture.forget).toHaveBeenCalledWith(verdictPath)
    expect(fixture.run).toHaveBeenCalledOnce()
  })
})
