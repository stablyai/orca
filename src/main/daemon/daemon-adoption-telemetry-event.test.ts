import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import { validate } from '../telemetry/validator'

const { trackMock, accessSyncMock, existsSyncMock, readFileSyncMock, getVersionMock } = vi.hoisted(
  () => ({
    trackMock: vi.fn(),
    accessSyncMock: vi.fn(),
    existsSyncMock: vi.fn(() => true),
    readFileSyncMock: vi.fn(),
    getVersionMock: vi.fn(() => '1.4.191')
  })
)
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  accessSync: accessSyncMock,
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => '/Users/alice'
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: getVersionMock })
}))

import {
  classifyDaemonAdoptionOrigin,
  trackDaemonAdopted,
  trackDaemonPtyCwdDeniedIfDiverged
} from './daemon-adoption-telemetry-event'

const stalePidRecord: ParsedDaemonPid = {
  pid: 1530,
  startedAtMs: 1,
  entryPath: '/x/daemon-entry.js',
  appVersion: '1.4.187',
  launchNonce: 'n',
  linuxStartTicks: null,
  bootId: null,
  spawnerExecPath:
    '/Users/alice/Library/Caches/com.stablyai.orca.ShipIt/u/Orca.app/Contents/MacOS/Orca'
}
const origin = { app_version_match: 'different', spawner_path_class: 'updater-cache' } as const
const PID_PATH = '/fake/daemon.pid'

beforeEach(() => {
  trackMock.mockReset()
  accessSyncMock.mockReset()
  existsSyncMock.mockReset().mockReturnValue(true)
  readFileSyncMock.mockReset().mockReturnValue(JSON.stringify(stalePidRecord))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('classifyDaemonAdoptionOrigin', () => {
  it('compares the recorded app version and classifies the spawner path', () => {
    expect(classifyDaemonAdoptionOrigin(stalePidRecord)).toEqual(origin)
    expect(classifyDaemonAdoptionOrigin({ ...stalePidRecord, appVersion: '1.4.191' })).toEqual({
      app_version_match: 'same',
      spawner_path_class: 'updater-cache'
    })
    expect(classifyDaemonAdoptionOrigin(null)).toEqual({
      app_version_match: 'unknown',
      spawner_path_class: 'unknown'
    })
  })
})

describe('trackDaemonAdopted', () => {
  it('emits a validator-accepted payload', () => {
    trackDaemonAdopted(stalePidRecord, 'intact', 7)
    expect(trackMock).toHaveBeenCalledTimes(1)
    const [name, props] = trackMock.mock.calls[0]
    expect(name).toBe('daemon_adopted')
    expect(props).toEqual({
      ...origin,
      tcc_attribution: 'intact',
      live_session_count_bucket: '6+'
    })
    expect(validate('daemon_adopted', props).ok).toBe(true)
  })

  it('swallows a throwing telemetry client', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    expect(() => trackDaemonAdopted(null, 'unknown', null)).not.toThrow()
  })
})

describe('trackDaemonPtyCwdDeniedIfDiverged', () => {
  it('emits only when the daemon was denied and the app can read the same cwd', () => {
    trackDaemonPtyCwdDeniedIfDiverged('/Users/alice/Documents/repo', false, PID_PATH)
    expect(accessSyncMock).toHaveBeenCalledWith('/Users/alice/Documents/repo', expect.any(Number))
    expect(trackMock).toHaveBeenCalledTimes(1)
    const [name, props] = trackMock.mock.calls[0]
    expect(name).toBe('daemon_pty_cwd_denied')
    expect(props).toEqual({ cwd_class: 'documents', ...origin })
    expect(validate('daemon_pty_cwd_denied', props).ok).toBe(true)
  })

  // False positives would drown the signal this event exists to measure, so every
  // non-divergent shape must stay silent.
  it('stays silent when the daemon could read the cwd or did not report', () => {
    trackDaemonPtyCwdDeniedIfDiverged('/Users/alice/Documents/repo', true, PID_PATH)
    trackDaemonPtyCwdDeniedIfDiverged('/Users/alice/Documents/repo', undefined, PID_PATH)
    trackDaemonPtyCwdDeniedIfDiverged(undefined, false, PID_PATH)
    expect(accessSyncMock).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('stays silent when the app cannot read the cwd either (no divergence)', () => {
    accessSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    trackDaemonPtyCwdDeniedIfDiverged('/Users/alice/Documents/repo', false, PID_PATH)
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('attributes the denial to the daemon recorded right now, not a startup snapshot', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        ...stalePidRecord,
        appVersion: '1.4.191',
        spawnerExecPath: '/Applications/Orca.app/Contents/MacOS/Orca'
      })
    )
    trackDaemonPtyCwdDeniedIfDiverged('/Users/alice/Documents/repo', false, PID_PATH)
    expect(readFileSyncMock).toHaveBeenCalledWith(PID_PATH, 'utf8')
    expect(trackMock.mock.calls[0][1]).toEqual({
      cwd_class: 'documents',
      app_version_match: 'same',
      spawner_path_class: 'applications'
    })
  })

  it('swallows a throwing app environment or pid-record read instead of failing the spawn', () => {
    getVersionMock.mockImplementationOnce(() => {
      throw new Error('AppEnvironment not initialized')
    })
    expect(() =>
      trackDaemonPtyCwdDeniedIfDiverged('/Users/alice/Documents/repo', false, PID_PATH)
    ).not.toThrow()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('stays silent off macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    trackDaemonPtyCwdDeniedIfDiverged('/home/alice/Documents/repo', false, PID_PATH)
    expect(accessSyncMock).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('swallows a throwing telemetry client', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    expect(() =>
      trackDaemonPtyCwdDeniedIfDiverged('/Users/alice/Documents/repo', false, PID_PATH)
    ).not.toThrow()
  })
})
