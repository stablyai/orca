import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import { ORCAD_PROFILE_PREFLIGHT_FLAG } from '../../shared/orcad-profile-preflight'
import { preflightBundledOrcadStartup, runOrcadProfilePreflight } from './orcad-profile-preflight'

const fixture = vi.hoisted(() => ({
  identity: vi.fn(),
  readVersion: vi.fn(),
  sql: vi.fn(),
  native: vi.fn(),
  run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))
vi.mock('./orcad-artifact-identity', () => ({ readOrcadArtifactIdentity: fixture.identity }))
vi.mock('./orcad-app-paths', () => ({ resolveOrcadInstallRoot: () => '/slot' }))
vi.mock('node:fs/promises', () => ({ readFile: fixture.readVersion }))
vi.mock('../persistence/profile-state/profile-state-runtime-preflight', () => ({
  preflightProfileStateRuntime: fixture.sql
}))
vi.mock('./orcad-bun-native-preflight', () => ({
  preflightOrcadBunNativeRuntime: fixture.native
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: fixture.run }))

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
      runtime: 'bun',
      runtimeVersion: ORCAD_BUN_VERSION,
      artifactVersion: identity,
      sqliteVersion: '3.53.2',
      revision: 1
    })
  }
}

beforeEach(() => {
  vi.spyOn(process, 'versions', 'get').mockReturnValue({
    ...process.versions,
    bun: ORCAD_BUN_VERSION
  })
  fixture.identity.mockResolvedValue(identity)
  fixture.readVersion.mockResolvedValue(`${identity}\n`)
  fixture.sql.mockResolvedValue({ sqliteVersion: '3.53.2', revision: 1 })
  fixture.native.mockResolvedValue(undefined)
  fixture.run.mockImplementation(async (spec) => readyResult(spec.args?.[2]))
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
      expect(fixture.run).toHaveBeenCalledOnce()
      expect(fixture.run).toHaveBeenCalledWith({
        program: join('/slot', platform === 'win32' ? 'bun-runtime.exe' : 'bun-runtime'),
        args: [join('/slot', 'orcad.js'), ORCAD_PROFILE_PREFLIGHT_FLAG, expect.any(String)],
        env: expect.objectContaining({ ORCA_BACKGROUND_LAUNCH: '1' }),
        timeoutMs: 90_000,
        maxOutputBytes: 64 * 1024,
        terminationBarrier: true
      })
      expect(fixture.sql).not.toHaveBeenCalled()
      expect(fixture.native).not.toHaveBeenCalled()
    }
  )

  it('leaves legacy Node startup on its existing readiness path', async () => {
    const { bun: _bun, ...versions } = process.versions
    vi.spyOn(process, 'versions', 'get').mockReturnValue(versions)
    await preflightBundledOrcadStartup()
    expect(fixture.identity).not.toHaveBeenCalled()
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it('refuses altered artifacts before launching a probe', async () => {
    fixture.readVersion.mockResolvedValue('0.1.0+bbbbbbbbbbbb')
    await expect(preflightBundledOrcadStartup()).rejects.toThrow('artifact version')
    expect(fixture.run).not.toHaveBeenCalled()
  })

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

  it('rejects stale output from a different challenge', async () => {
    fixture.run.mockResolvedValue(readyResult(nonce))
    await expect(preflightBundledOrcadStartup()).rejects.toThrow('expected candidate runtime')
  })

  it('rechecks the child artifact identity against the verified installed version', async () => {
    fixture.run.mockImplementation(async (spec) => {
      const result = readyResult(spec.args?.[2])
      return { ...result, stdout: result.stdout.replace(identity, '0.1.0+bbbbbbbbbbbb') }
    })
    await expect(preflightBundledOrcadStartup()).rejects.toThrow('expected candidate runtime')
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
