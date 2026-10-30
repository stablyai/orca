import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { readServeAbortPark, writeServeAbortPark } from '../../shared/serve-abort-park'
import { preflightElectronServe, recordElectronServeStartupAbort } from './serve-electron-preflight'
import { RuntimeClientError } from './types'

const METADATA: RuntimeMetadata = {
  runtimeId: 'runtime-1',
  pid: 4242,
  transports: [{ kind: 'unix', endpoint: '/tmp/orca-test.sock' }],
  authToken: 'token',
  startedAt: 1
}

function status(reachable: boolean, pid: number | null = 4242) {
  return {
    id: 'local',
    ok: true as const,
    result: {
      app: { running: reachable, pid },
      runtime: { state: reachable ? 'ready' : 'stale_bootstrap', reachable, runtimeId: null },
      graph: { state: 'not_running' }
    },
    _meta: { runtimeId: null }
  }
}

describe('preflightElectronServe', () => {
  let userData: string
  let stderr: ReturnType<typeof vi.spyOn>
  let stdout: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-serve-preflight-'))
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function deps(
    overrides: {
      metadata?: RuntimeMetadata | null
      reachable?: boolean
      probe?: 'accepting' | 'not-listening' | 'unproven'
      statusError?: Error
    } = {}
  ) {
    return {
      readMetadata: () => (overrides.metadata === undefined ? METADATA : overrides.metadata),
      readStatus: vi.fn(async () => {
        if (overrides.statusError) {
          throw overrides.statusError
        }
        return status(overrides.reachable ?? false)
      }),
      probeListener: vi.fn(async () => overrides.probe ?? 'not-listening')
    }
  }

  it('starts at once, synchronously, when nothing has published this profile', () => {
    expect(
      preflightElectronServe({}, userData, { platform: 'linux', deps: deps({ metadata: null }) })
    ).toBeNull()
  })

  it('refuses with exit 3 when a live Orca answers for the profile', async () => {
    await expect(
      preflightElectronServe({}, userData, { platform: 'linux', deps: deps({ reachable: true }) })
    ).resolves.toBe(3)
    expect(String(stderr.mock.calls[0]?.[0])).toContain(
      'Orca is already running for this userData profile as pid 4242; not starting a second process.'
    )
  })

  it('prints the refusal as a JSON envelope for --json callers', async () => {
    await preflightElectronServe({ json: true }, userData, {
      platform: 'linux',
      deps: deps({ reachable: true })
    })
    const envelope = JSON.parse(String(stdout.mock.calls[0]?.[0]))
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'runtime_serve_already_running', data: { verdict: 'live', pid: 4242 } }
    })
  })

  it('treats an accepting socket as live and an unanswered one as unverifiable, both refused', async () => {
    await expect(
      preflightElectronServe({}, userData, {
        platform: 'linux',
        deps: deps({ probe: 'accepting' })
      })
    ).resolves.toBe(3)
    await expect(
      preflightElectronServe({}, userData, { platform: 'linux', deps: deps({ probe: 'unproven' }) })
    ).resolves.toBe(3)
    expect(String(stderr.mock.calls[1]?.[0])).toContain('cannot be shown to be free')
  })

  it('treats a denied status check as unverifiable, not as stopped', async () => {
    const denied = new RuntimeClientError('runtime_access_denied', 'denied')
    await expect(
      preflightElectronServe({}, userData, {
        platform: 'linux',
        deps: deps({ statusError: denied })
      })
    ).resolves.toBe(3)
    expect(String(stderr.mock.calls[0]?.[0])).toContain("refused this CLI's credentials")
  })

  it('starts when the published endpoint definitively refuses (the old runtime is gone)', async () => {
    await expect(
      preflightElectronServe({}, userData, {
        platform: 'linux',
        deps: deps({ probe: 'not-listening' })
      })
    ).resolves.toBeNull()
  })

  describe('remembered macOS startup abort', () => {
    const fingerprint = () => 'Background|ssh=1|sandbox=0'

    it('refuses a later run from the same environment with exit 78 before anything else', () => {
      recordElectronServeStartupAbort(userData, 'Orca serve aborted with SIGABRT on macOS.', {
        now: 1_000,
        fingerprint
      })
      const result = preflightElectronServe({}, userData, {
        platform: 'darwin',
        now: 1_000 + 5 * 60_000,
        fingerprint,
        deps: deps({ metadata: null })
      })
      expect(result).toBe(78)
      expect(String(stderr.mock.calls[0]?.[0])).toContain('--force')
    })

    it('lets a different environment, an expired park, or --force through', () => {
      recordElectronServeStartupAbort(userData, 'aborted', { now: 1_000, fingerprint })
      const run = (args: { force?: boolean }, now: number, print = fingerprint) =>
        preflightElectronServe(args, userData, {
          platform: 'darwin',
          now,
          fingerprint: print,
          deps: deps({ metadata: null })
        })
      expect(run({}, 2_000, () => 'Aqua|ssh=0|sandbox=0')).toBeNull()
      expect(run({}, 1_000 + 31 * 60_000)).toBeNull()
      expect(run({ force: true }, 2_000)).toBeNull()
      expect(readServeAbortPark(userData)).toBeNull()
    })

    it('never parks off macOS', () => {
      writeServeAbortPark(userData, {
        schemaVersion: 1,
        verdict: 'environment_abort',
        at: 1_000,
        envFingerprint: fingerprint(),
        diagnostic: 'aborted'
      })
      expect(
        preflightElectronServe({}, userData, {
          platform: 'linux',
          now: 2_000,
          fingerprint,
          deps: deps({ metadata: null })
        })
      ).toBeNull()
    })
  })
})
