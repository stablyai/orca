import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_STATE_RECOVERY_FLAG,
  PROFILE_STATE_RECOVERY_RESULT_PREFIX
} from '../../shared/profile-state-recovery-command'
import {
  canLaunchProfileStateRecovery,
  launchProfileStateRecovery
} from './profile-state-recovery-launch'

const mocks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.run }))
vi.mock('./launch', () => ({
  resolveForegroundOrcaExecutable: () => '/packaged/Orca',
  resolveAppRoot: () => '/application',
  getExecutableAppArgs: () => ['/application'],
  stripElectronRunAsNode: (env: NodeJS.ProcessEnv) => {
    const clean = { ...env }
    delete clean.ELECTRON_RUN_AS_NODE
    return clean
  }
}))

const result = {
  profileId: 'profile',
  dataFile: '/root/orca-data.json',
  databaseFile: '/root/profile-state.db',
  exportPaths: [],
  backups: [],
  revision: 1,
  quarantineDirectory: '/root/quarantine',
  removedDatabaseFiles: [],
  storage: 'json',
  restoredPath: '/root/orca-data.json'
}
const request = { userDataPath: '.', selector: { kind: 'json', revision: 1 } } as const
beforeEach(() => {
  mocks.run.mockReset().mockResolvedValue({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}${JSON.stringify({ ok: true, result })}\n`,
    stderr: ''
  })
})
afterEach(() => vi.unstubAllEnvs())

describe('profile-state recovery launch', () => {
  it('preserves direct participation only for plain Node without an explicit Electron executable', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined)
    vi.stubEnv('ORCA_APP_EXECUTABLE', undefined)
    expect(canLaunchProfileStateRecovery()).toBe(false)
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    expect(canLaunchProfileStateRecovery()).toBe(true)
    vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined)
    vi.stubEnv('ORCA_APP_EXECUTABLE', '/explicit/Orca')
    expect(canLaunchProfileStateRecovery()).toBe(true)
  })

  it('uses a foreground-safe serve request and binds the canonical recovery root', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('ORCA_USER_DATA_PATH', '/stale/root')
    expect(await launchProfileStateRecovery(request)).toEqual(result)
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/packaged/Orca',
        args: [
          '/application',
          '--serve',
          PROFILE_STATE_RECOVERY_FLAG,
          JSON.stringify({ ...request, userDataPath: realpathSync('.') })
        ],
        env: expect.objectContaining({
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_USER_DATA_PATH: realpathSync('.')
        }),
        timeoutMs: null
      })
    )
    expect(mocks.run.mock.calls[0][0].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('round-trips current JSON selection without requiring an invented revision', async () => {
    const current = { ...result, revision: null }
    mocks.run.mockResolvedValue({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}${JSON.stringify({ ok: true, result: current })}\n`,
      stderr: ''
    })
    expect(
      await launchProfileStateRecovery({ userDataPath: '.', selector: { kind: 'current-json' } })
    ).toEqual(current)
    expect(mocks.run.mock.calls[0][0].args.at(-1)).toContain('"kind":"current-json"')
  })

  it('preserves a structured refusal from the lock owner', async () => {
    mocks.run.mockResolvedValue({
      code: 1,
      stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}${JSON.stringify({ ok: false, code: 'invalid_argument', message: 'Backup unavailable' })}`
    })
    await expect(launchProfileStateRecovery(request)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Backup unavailable'
    })
  })

  it('round-trips latest JSON selection and the exported SQLite revision', async () => {
    expect(
      await launchProfileStateRecovery({ userDataPath: '.', selector: { kind: 'latest-json' } })
    ).toEqual(result)
    expect(mocks.run.mock.calls[0][0].args.at(-1)).toContain('"kind":"latest-json"')
  })

  it.each([
    { code: 1 },
    { signal: 'SIGKILL' },
    { timedOut: true },
    { outputTruncated: true },
    { stdout: '' },
    { stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}{` },
    { stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}{"ok":true,"result":{}}` },
    {
      stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}{}\n${PROFILE_STATE_RECOVERY_RESULT_PREFIX}{}`
    }
  ])('rejects incomplete or ambiguous child results %j', async (override) => {
    const original = await mocks.run()
    mocks.run.mockResolvedValue({ ...original, ...override })
    await expect(launchProfileStateRecovery(request)).rejects.toMatchObject({
      code: 'runtime_error'
    })
  })

  it('propagates launch failure without retrying another recovery path', async () => {
    mocks.run.mockRejectedValue(new Error('Executable unavailable'))
    await expect(launchProfileStateRecovery(request)).rejects.toThrow('Executable unavailable')
    expect(mocks.run).toHaveBeenCalledOnce()
  })

  it('retains bounded child diagnostics when recovery exits without a result', async () => {
    mocks.run.mockResolvedValue({
      code: null,
      signal: 'SIGTRAP',
      timedOut: false,
      stdout: '',
      stderr: `${'x'.repeat(5000)}\nsandbox unavailable\n`
    })
    await expect(launchProfileStateRecovery(request)).rejects.toMatchObject({
      data: {
        exitCode: null,
        signal: 'SIGTRAP',
        timedOut: false,
        outputTruncated: false,
        stderr: `${'x'.repeat(5000)}\nsandbox unavailable`.slice(-4096)
      }
    })
    expect(mocks.run).toHaveBeenCalledOnce()
  })
})
