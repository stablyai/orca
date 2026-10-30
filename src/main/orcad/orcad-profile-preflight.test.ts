import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { ORCAD_STARTUP_PREFLIGHT_FLAG } from '../../shared/orcad-profile-preflight'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'
import type * as BundledRuntime from './orcad-bundled-runtime'
import { resolveOrcadExitCode } from './orcad-exit-code'
import {
  confirmBundledOrcadStartupQualified,
  discardBundledOrcadStartupQualification,
  forgetBundledOrcadStartupQualification,
  preflightBundledOrcadStartup,
  runOrcadProfilePreflight
} from './orcad-profile-preflight'

const fixture = vi.hoisted(() => ({
  identity: vi.fn(),
  readVersion: vi.fn(),
  sql: vi.fn(),
  native: vi.fn(),
  bundled: vi.fn<(directory: string) => boolean>(),
  run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  qualificationKey: vi.fn<(directory: string, version: string) => Promise<string>>(),
  consumeQualification: vi.fn<(directory: string, key: string) => Promise<boolean>>(),
  recordQualification: vi.fn<(directory: string, key: string) => Promise<void>>(),
  discardQualification: vi.fn<(directory: string) => Promise<void>>(),
  qualifiable: vi.fn<(directory: string) => boolean>()
}))
vi.mock('./orcad-startup-qualification', () => ({
  orcadStartupQualificationKey: fixture.qualificationKey,
  consumeOrcadStartupQualification: fixture.consumeQualification,
  recordOrcadStartupQualification: fixture.recordQualification,
  discardOrcadStartupQualification: fixture.discardQualification,
  isQualifiableOrcadSlot: fixture.qualifiable
}))
vi.mock('./orcad-bundled-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRuntime>()),
  isRunningAsBundledOrcadRuntime: fixture.bundled,
  resolveBundledOrcadSlot: () => '/slot'
}))
vi.mock('./orcad-artifact-identity', () => ({ readOrcadArtifactIdentity: fixture.identity }))
vi.mock('node:fs/promises', () => ({ readFile: fixture.readVersion }))
vi.mock('../persistence/profile-state/profile-state-runtime-preflight', () => ({
  preflightProfileStateRuntime: fixture.sql
}))
vi.mock('./orcad-runtime-native-preflight', () => ({
  preflightOrcadNativeRuntime: fixture.native
}))
vi.mock('@orca/process-host', () => ({ runProcess: fixture.run }))

const identity = '0.1.0+aaaaaaaaaaaa'
const nonce = '743bf9c8-2e58-4c79-a0ac-52c8d3e8e103'

function readyResult(challenge: string | undefined): ProcessResult {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    stderr: '',
    stdout: JSON.stringify({
      type: 'orca_profile_state_ready',
      nonce: challenge,
      runtime: 'node',
      runtimeVersion: NODE_RUNTIME_PIN.version,
      artifactVersion: identity,
      sqliteVersion: '3.53.2',
      revision: 1
    })
  }
}

beforeEach(() => {
  vi.spyOn(process, 'versions', 'get').mockReturnValue({
    ...process.versions,
    node: NODE_RUNTIME_PIN.version
  })
  fixture.bundled.mockReturnValue(true)
  fixture.identity.mockResolvedValue(identity)
  fixture.readVersion.mockResolvedValue(`${identity}\n`)
  fixture.sql.mockResolvedValue({ sqliteVersion: '3.53.2', revision: 1 })
  fixture.native.mockResolvedValue(undefined)
  fixture.run.mockImplementation(async (spec) => readyResult(spec.args?.[2]))
  fixture.qualificationKey.mockResolvedValue('key-1')
  fixture.consumeQualification.mockResolvedValue(false)
  fixture.recordQualification.mockResolvedValue(undefined)
  fixture.discardQualification.mockResolvedValue(undefined)
  fixture.qualifiable.mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('bundled Orca startup readiness', () => {
  it.each(['win32', 'darwin', 'linux'] as const)(
    'isolates native process state in the exact bundled %s executable',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      await preflightBundledOrcadStartup()
      expect(fixture.bundled).toHaveBeenCalledWith('/slot')
      expect(fixture.run).toHaveBeenCalledOnce()
      expect(fixture.run).toHaveBeenCalledWith({
        program: process.execPath,
        args: [join('/slot', 'orcad-server.js'), ORCAD_STARTUP_PREFLIGHT_FLAG, expect.any(String)],
        env: expect.objectContaining({ ORCA_BACKGROUND_LAUNCH: '1' }),
        timeoutMs: 90_000,
        maxOutputBytes: 64 * 1024,
        terminationBarrier: true
      })
      expect(fixture.sql).not.toHaveBeenCalled()
      expect(fixture.native).not.toHaveBeenCalled()
    }
  )

  it('leaves an unpackaged or host-Node start on its existing readiness path', async () => {
    fixture.bundled.mockReturnValue(false)
    await preflightBundledOrcadStartup()
    expect(fixture.identity).not.toHaveBeenCalled()
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it('hashes installed bytes only in the isolated child', async () => {
    await preflightBundledOrcadStartup()
    expect(fixture.identity).not.toHaveBeenCalled()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runOrcadProfilePreflight(nonce, { nativeFeatures: false })
    expect(fixture.identity).toHaveBeenCalledOnce()
  })

  it.each(['missing artifact', 'corrupt build target'])(
    'classifies %s as a configuration fault before testing SQLite',
    async (message) => {
      fixture.identity.mockRejectedValue(new Error(message))
      const failure = await runOrcadProfilePreflight(nonce).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(OrcadBundledRuntimeError)
      expect(resolveOrcadExitCode(failure)).toBe(78)
      expect(fixture.sql).not.toHaveBeenCalled()
    }
  )

  it('classifies changed artifact bytes as configuration faults on normal startup', async () => {
    fixture.readVersion.mockResolvedValue('0.1.0+bbbbbbbbbbbb')
    await expect(preflightBundledOrcadStartup()).rejects.toThrow(OrcadBundledRuntimeError)
  })

  it.each([undefined, 'broken-version'])(
    'classifies an unreadable or malformed version marker as configuration: %s',
    async (version) => {
      if (version === undefined) {
        fixture.readVersion.mockRejectedValue(new Error('ENOENT'))
      } else {
        fixture.readVersion.mockResolvedValue(version)
      }
      await expect(preflightBundledOrcadStartup()).rejects.toThrow(OrcadBundledRuntimeError)
      expect(fixture.run).not.toHaveBeenCalled()
    }
  )

  it('awaits probe termination before permitting server startup', async () => {
    const exit = Promise.withResolvers<ProcessResult>()
    fixture.run.mockReturnValue(exit.promise)
    let admitted = false
    const startup = preflightBundledOrcadStartup().then(() => {
      admitted = true
    })
    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledOnce())
    expect(admitted).toBe(false)
    exit.resolve(readyResult(fixture.run.mock.calls[0]?.[0].args?.[2]))
    await startup
    expect(admitted).toBe(true)
  })

  it.each([{ code: 78 }, { timedOut: true }, { outputTruncated: true }])(
    'refuses a failed child even if it emitted a valid readiness reply: %j',
    async (failure) => {
      fixture.run.mockImplementation(async (spec) => ({
        ...readyResult(spec.args?.[2]),
        ...failure,
        stderr: 'native probe failed'
      }))
      await expect(preflightBundledOrcadStartup()).rejects.toThrow('native probe failed')
    }
  )

  it('preserves configuration exit status from the isolated child', async () => {
    fixture.run.mockImplementation(async (spec) => ({ ...readyResult(spec.args?.[2]), code: 78 }))
    const failure = await preflightBundledOrcadStartup().catch((error: unknown) => error)
    expect(resolveOrcadExitCode(failure)).toBe(78)
  })

  it('keeps transient SQLite readiness failures retryable', async () => {
    fixture.sql.mockRejectedValue(new Error('SQLITE_BUSY'))
    const failure = await runOrcadProfilePreflight(nonce).catch((error: unknown) => error)
    expect(resolveOrcadExitCode(failure)).toBe(1)
  })

  it('leaves optional native probes to runtime health on normal startup', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runOrcadProfilePreflight(nonce, { nativeFeatures: false })
    expect(fixture.sql).toHaveBeenCalledOnce()
    expect(fixture.native).toHaveBeenCalledWith({ nativeFeatures: false })
  })

  it('rejects stale output from a different challenge', async () => {
    fixture.run.mockResolvedValue(readyResult(nonce))
    await expect(preflightBundledOrcadStartup()).rejects.toThrow('invalid readiness identity')
  })

  it('rechecks the child artifact identity against the verified installed version', async () => {
    fixture.run.mockImplementation(async (spec) => {
      const result = readyResult(spec.args?.[2])
      return { ...result, stdout: result.stdout.replace(identity, '0.1.0+bbbbbbbbbbbb') }
    })
    await expect(preflightBundledOrcadStartup()).rejects.toThrow('invalid readiness identity')
  })

  it('runs disposable probes directly in the command child without recursive spawning', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runOrcadProfilePreflight(nonce)
    expect(fixture.sql).toHaveBeenCalledOnce()
    expect(fixture.native).toHaveBeenCalledOnce()
    expect(fixture.run).not.toHaveBeenCalled()
    expect(output).toHaveBeenCalledWith(readyResult(nonce).stdout)
  })
})

describe('startup qualification on an unchanged host', () => {
  beforeEach(async () => {
    // Drop qualification left pending by an earlier case.
    await confirmBundledOrcadStartupQualified()
    fixture.recordQualification.mockClear()
  })

  it('skips the preflight child when the last launch with this key reached readiness', async () => {
    fixture.consumeQualification.mockResolvedValue(true)

    await preflightBundledOrcadStartup()

    expect(fixture.qualificationKey).toHaveBeenCalledWith('/slot', identity)
    expect(fixture.consumeQualification).toHaveBeenCalledWith('/slot', 'key-1')
    expect(fixture.run).not.toHaveBeenCalled()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
    await confirmBundledOrcadStartupQualified()
    expect(fixture.recordQualification).toHaveBeenCalledExactlyOnceWith('/slot', 'key-1')
  })

  it('reports whether the slot was qualified from its marker', async () => {
    fixture.consumeQualification.mockResolvedValue(true)
    await expect(preflightBundledOrcadStartup()).resolves.toBe(true)
    await confirmBundledOrcadStartupQualified()

    fixture.consumeQualification.mockResolvedValue(false)
    await expect(preflightBundledOrcadStartup()).resolves.toBe(false)
  })

  it('records nothing once a launch forgot its qualification (node-pty probe not ok)', async () => {
    await preflightBundledOrcadStartup()
    forgetBundledOrcadStartupQualification()
    await confirmBundledOrcadStartupQualified()

    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('runs the preflight child without a matching marker, and records only after readiness', async () => {
    await preflightBundledOrcadStartup()

    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
    await confirmBundledOrcadStartupQualified()
    expect(fixture.recordQualification).toHaveBeenCalledExactlyOnceWith('/slot', 'key-1')
  })

  it('records nothing after a failed preflight, and voids any marker already there', async () => {
    fixture.run.mockImplementation(async (spec) => ({ ...readyResult(spec.args?.[2]), code: 1 }))

    await expect(preflightBundledOrcadStartup()).rejects.toThrow('failed readiness')
    await confirmBundledOrcadStartupQualified()

    expect(fixture.recordQualification).not.toHaveBeenCalled()
    expect(fixture.discardQualification).toHaveBeenCalledExactlyOnceWith('/slot')
  })

  it('voids the marker when the child answers with the wrong identity', async () => {
    fixture.run.mockResolvedValue(readyResult(nonce))

    await expect(preflightBundledOrcadStartup()).rejects.toThrow('invalid readiness identity')

    expect(fixture.discardQualification).toHaveBeenCalledExactlyOnceWith('/slot')
  })

  it('never reads or writes a marker outside a managed slot', async () => {
    fixture.qualifiable.mockReturnValue(false)
    fixture.consumeQualification.mockResolvedValue(true)

    await preflightBundledOrcadStartup()
    await confirmBundledOrcadStartupQualified()

    expect(fixture.qualifiable).toHaveBeenCalledWith('/slot')
    expect(fixture.qualificationKey).not.toHaveBeenCalled()
    expect(fixture.consumeQualification).not.toHaveBeenCalled()
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('falls back to the preflight child, and records nothing, when the key cannot be computed', async () => {
    fixture.qualificationKey.mockRejectedValue(new Error('EACCES'))

    await preflightBundledOrcadStartup()
    await confirmBundledOrcadStartupQualified()

    expect(fixture.consumeQualification).not.toHaveBeenCalled()
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('always runs the preflight child on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    fixture.consumeQualification.mockResolvedValue(true)

    // A matching marker never qualifies a Windows slot, so its node-pty probe runs too.
    await expect(preflightBundledOrcadStartup()).resolves.toBe(false)
    await confirmBundledOrcadStartupQualified()

    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('discards the slot marker after node-pty fails to load, and records nothing for this launch', async () => {
    fixture.consumeQualification.mockResolvedValue(true)
    await preflightBundledOrcadStartup()

    await discardBundledOrcadStartupQualification()
    await confirmBundledOrcadStartupQualified()

    expect(fixture.discardQualification).toHaveBeenCalledExactlyOnceWith('/slot')
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('unlinks the marker only after an in-flight record has renamed it into place', async () => {
    const order: string[] = []
    const record = Promise.withResolvers<void>()
    fixture.recordQualification.mockImplementation(async () => {
      await record.promise
      order.push('recorded')
    })
    fixture.discardQualification.mockImplementation(async () => {
      order.push('discarded')
    })
    await preflightBundledOrcadStartup()

    const confirming = confirmBundledOrcadStartupQualified()
    const discarding = discardBundledOrcadStartupQualification()
    await Promise.resolve()
    expect(order).toEqual([])
    record.resolve()
    await Promise.all([confirming, discarding])

    expect(order).toEqual(['recorded', 'discarded'])
  })

  it('touches no marker on Windows or outside a managed slot when node-pty fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await discardBundledOrcadStartupQualification()
    fixture.qualifiable.mockReturnValue(false)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await discardBundledOrcadStartupQualification()

    expect(fixture.discardQualification).not.toHaveBeenCalled()
  })

  it('never skips the version check, which runs before any marker is read', async () => {
    fixture.readVersion.mockRejectedValue(new Error('ENOENT'))
    fixture.consumeQualification.mockResolvedValue(true)

    await expect(preflightBundledOrcadStartup()).rejects.toThrow(OrcadBundledRuntimeError)
    expect(fixture.consumeQualification).not.toHaveBeenCalled()
  })
})
