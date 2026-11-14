import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_STATE_RECOVERY_FLAG,
  PROFILE_STATE_RECOVERY_RESULT_PREFIX
} from '../../../shared/profile-state-recovery-command'
import { launchProfileStateRecovery } from './profile-state-recovery-launch'

const mocks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.run }))
vi.mock('../orca-app-executable', () => ({
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

  it.each([
    { code: 1 },
    { signal: 'SIGKILL' },
    { timedOut: true },
    { outputTruncated: true },
    { stdout: '' },
    { stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}{` },
    { stdout: `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}{"ok":true,"result":{}}` }
  ])('rejects incomplete child results %j', async (override) => {
    const original = await mocks.run()
    mocks.run.mockResolvedValue({ ...original, ...override })
    await expect(launchProfileStateRecovery(request)).rejects.toMatchObject({
      code: 'runtime_error'
    })
  })
})
