import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME
} from '../../shared/orcad-artifacts'
import {
  claimStartupPreflightSkip,
  clearAbandonedStartupPreflightClaim,
  computeStartupPreflightFingerprint,
  forgetSlotStartupPreflightVerdict,
  forgetStartupPreflightVerdict,
  readStartupPreflightVerdict,
  settleSlotStartupPreflightSkip,
  startupPreflightVerdictPath,
  wasStartupPreflightSkipped,
  writeStartupPreflightVerdict,
  type StartupPreflightRuntime
} from './orcad-startup-preflight-verdict'

vi.mock('./orcad-artifact-identity', () => ({
  listOrcadArtifactFiles: async () => ['orcad-server.js', 'daemon-entry.js']
}))

let slot: string
let node: string
let temp: string
let verdictPath: string
const runtime = (overrides: Partial<StartupPreflightRuntime> = {}): StartupPreflightRuntime => ({
  execPath: node,
  nodeVersion: '24.21.0',
  platform: 'darwin',
  arch: 'x64',
  osRelease: '25.3.0',
  tempDirectory: temp,
  libraryCache: join(slot, 'ld.so.cache'),
  ...overrides
})

function withManagedEnv(run: () => void): void {
  const previous = process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
  try {
    process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] = '/root'
    run()
  } finally {
    if (previous === undefined) {
      delete process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
    } else {
      process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] = previous
    }
  }
}

const markerFiles = () => readdirSync(slot).filter((name) => name.startsWith('.orcad-startup'))

beforeEach(() => {
  slot = mkdtempSync(join(tmpdir(), 'orcad-preflight-verdict-'))
  for (const file of [
    'orcad-server.js',
    'daemon-entry.js',
    ORCAD_VERSION_FILENAME,
    ORCAD_SERVER_TARGET_FILENAME,
    ORCAD_MOBILE_WEB_MANIFEST
  ]) {
    mkdirSync(dirname(join(slot, file)), { recursive: true })
    writeFileSync(join(slot, file), file)
  }
  node = join(slot, 'node')
  writeFileSync(node, 'node')
  temp = join(slot, 'tmp')
  mkdirSync(temp)
  verdictPath = join(slot, '.orcad-startup-preflight.json')
})

afterEach(() => {
  chmodSync(temp, 0o700)
  rmSync(slot, { recursive: true, force: true })
})

describe('startup preflight fingerprint', () => {
  it('only lives in a client-managed slot', () => {
    expect(startupPreflightVerdictPath(slot, {})).toBeNull()
    expect(
      startupPreflightVerdictPath(slot, { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/root' })
    ).toBe(verdictPath)
  })

  it('is stable for an unchanged install and runtime', async () => {
    const first = await computeStartupPreflightFingerprint(slot, runtime())
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(await computeStartupPreflightFingerprint(slot, runtime())).toBe(first)
  })

  it.each([
    ['an artifact is rewritten', () => writeFileSync(join(slot, 'daemon-entry.js'), 'changed!')],
    [
      'an artifact is touched',
      () => utimesSync(join(slot, 'orcad-server.js'), new Date(1), new Date(1))
    ],
    ['the version file changes', () => writeFileSync(join(slot, ORCAD_VERSION_FILENAME), 'next')],
    ['the Node executable is replaced', () => writeFileSync(node, 'another node')]
  ])('changes when %s', async (_label, change) => {
    const before = await computeStartupPreflightFingerprint(slot, runtime())
    change()
    expect(await computeStartupPreflightFingerprint(slot, runtime())).not.toBe(before)
  })

  it.each([
    ['Node version', 'darwin', { nodeVersion: '24.22.0' }],
    ['architecture', 'darwin', { arch: 'arm64' }],
    // An OS update can change native libraries on every platform, not only Linux.
    ['OS release on macOS', 'darwin', { osRelease: '25.4.0' }],
    ['OS release on Windows', 'win32', { osRelease: '10.0.26100' }]
  ] satisfies [string, NodeJS.Platform, Partial<StartupPreflightRuntime>][])(
    'changes with the %s',
    async (_label, platform, change) => {
      const base = runtime({ platform })
      const before = await computeStartupPreflightFingerprint(slot, base)
      expect(await computeStartupPreflightFingerprint(slot, { ...base, ...change })).not.toBe(
        before
      )
    }
  )

  it('is null, so the probe runs, when an artifact is missing', async () => {
    rmSync(join(slot, 'daemon-entry.js'))
    expect(await computeStartupPreflightFingerprint(slot, runtime())).toBeNull()
  })

  it('is null when the probe’s temp directory is not writable', async () => {
    chmodSync(temp, 0o500)
    expect(await computeStartupPreflightFingerprint(slot, runtime())).toBeNull()
  })

  it('is null when the temp directory is missing', async () => {
    expect(
      await computeStartupPreflightFingerprint(slot, runtime({ tempDirectory: join(slot, 'gone') }))
    ).toBeNull()
  })

  it('ignores files appearing in the temp directory, as the probe’s own database does', async () => {
    const before = await computeStartupPreflightFingerprint(slot, runtime())
    writeFileSync(join(temp, 'orca-profile-preflight-x'), 'scratch')
    expect(await computeStartupPreflightFingerprint(slot, runtime())).toBe(before)
  })

  it('on Linux, keys the library cache by content: a boot-time rewrite keeps the verdict', async () => {
    const cache = join(slot, 'ld.so.cache')
    writeFileSync(cache, 'libs-v1')
    const linux = runtime({ platform: 'linux' })
    const before = await computeStartupPreflightFingerprint(slot, linux)
    expect(before).not.toBeNull()
    // WSL regenerates the cache on every boot: same bytes, new mtime.
    utimesSync(cache, new Date(), new Date(Date.now() + 60_000))
    writeFileSync(cache, 'libs-v1')
    expect(await computeStartupPreflightFingerprint(slot, linux)).toBe(before)
    writeFileSync(cache, 'libs-v2')
    expect(await computeStartupPreflightFingerprint(slot, linux)).not.toBe(before)
  })

  it('is null on Linux without a shared-library cache: unknown means probe', async () => {
    expect(
      await computeStartupPreflightFingerprint(slot, runtime({ platform: 'linux' }))
    ).toBeNull()
  })
})

describe('startup preflight verdict file', () => {
  it('round-trips atomically and rejects anything malformed or from an older format', async () => {
    const verdict = {
      fingerprint: 'a'.repeat(64),
      artifactVersion: '0.1.0+aaaaaaaaaaaa',
      runtimeVersion: '24.21.0'
    }
    await writeStartupPreflightVerdict(verdictPath, verdict)
    expect(await readStartupPreflightVerdict(verdictPath)).toEqual({ format: 3, ...verdict })
    expect(readdirSync(slot).filter((name) => name.endsWith('.tmp'))).toEqual([])
    writeFileSync(verdictPath, JSON.stringify({ ...verdict, format: 2 }))
    expect(await readStartupPreflightVerdict(verdictPath)).toBeNull()
    writeFileSync(verdictPath, 'not json')
    expect(await readStartupPreflightVerdict(verdictPath)).toBeNull()
  })
})

describe('skip claims', () => {
  it('claims atomically: a second claim on the same slot fails while the first is open', async () => {
    expect(await claimStartupPreflightSkip(verdictPath)).toBe(true)
    expect(wasStartupPreflightSkipped()).toBe(true)
    expect(await claimStartupPreflightSkip(verdictPath)).toBe(false)
  })

  it('settles only its own claim', async () => {
    writeFileSync(`${verdictPath}.pending`, `${process.pid} someone-else\n`)
    withManagedEnv(() => settleSlotStartupPreflightSkip(() => slot))
    expect(markerFiles()).toContain('.orcad-startup-preflight.json.pending')
    rmSync(`${verdictPath}.pending`)
    expect(await claimStartupPreflightSkip(verdictPath)).toBe(true)
    withManagedEnv(() => settleSlotStartupPreflightSkip(() => slot))
    expect(markerFiles()).toEqual([])
  })

  it('forgets the verdict but never another start’s claim', async () => {
    writeFileSync(verdictPath, '{}')
    writeFileSync(`${verdictPath}.pending`, `${process.pid} someone-else\n`)
    await forgetStartupPreflightVerdict(verdictPath)
    expect(markerFiles()).toEqual(['.orcad-startup-preflight.json.pending'])
  })

  it('forgets its own claim with the verdict', async () => {
    writeFileSync(verdictPath, '{}')
    expect(await claimStartupPreflightSkip(verdictPath)).toBe(true)
    await forgetStartupPreflightVerdict(verdictPath)
    expect(markerFiles()).toEqual([])
  })

  it('clears a dead start’s abandoned claim after a passed probe, but keeps a live one', async () => {
    writeFileSync(`${verdictPath}.pending`, `${process.pid} live-start\n`)
    await clearAbandonedStartupPreflightClaim(verdictPath)
    expect(markerFiles()).toContain('.orcad-startup-preflight.json.pending')
    writeFileSync(`${verdictPath}.pending`, `2147483646 dead-start\n`)
    await clearAbandonedStartupPreflightClaim(verdictPath)
    expect(markerFiles()).toEqual([])
  })

  it('forgets the running slot verdict on a failed start, only when managed', () => {
    writeFileSync(verdictPath, '{}')
    forgetSlotStartupPreflightVerdict(() => slot)
    expect(markerFiles()).toContain('.orcad-startup-preflight.json')
    withManagedEnv(() => forgetSlotStartupPreflightVerdict(() => slot))
    expect(markerFiles()).not.toContain('.orcad-startup-preflight.json')
    expect(() =>
      forgetSlotStartupPreflightVerdict(() => {
        throw new Error('no slot')
      })
    ).not.toThrow()
  })
})
