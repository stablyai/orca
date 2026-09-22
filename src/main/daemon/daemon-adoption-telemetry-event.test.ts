import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import { validate } from '../telemetry/validator'

const { trackMock, opendirMock, existsSyncMock, readFileSyncMock, getVersionMock } = vi.hoisted(
  () => ({
    trackMock: vi.fn(),
    opendirMock: vi.fn(),
    existsSyncMock: vi.fn(() => true),
    readFileSyncMock: vi.fn(),
    getVersionMock: vi.fn(() => '1.4.191')
  })
)
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock
}))
// The app-side read is async on purpose: it can sit on an unanswered macOS folder prompt.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  opendir: opendirMock
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
  hasDaemonPtyCwdDenialDiverged,
  reportDaemonPtyCwdVerdict,
  trackDaemonAdopted,
  trackDaemonPtyCwdDenied
} from './daemon-adoption-telemetry-event'
import {
  getDaemonFolderAccessMismatch,
  resetDaemonFolderAccessMismatchForTests
} from './daemon-folder-access-mismatch'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

const DAEMON: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }

const DENIED_CWD = '/Users/alice/Documents/repo'

function readableDir(): { read: () => Promise<{ name: string }>; close: () => Promise<void> } {
  return { read: async () => ({ name: 'entry' }), close: async () => {} }
}

function failWith(code: string): never {
  throw Object.assign(new Error(code), { code })
}

const stalePidRecord: ParsedDaemonPid = {
  pid: 1530,
  startedAtMs: 1,
  entryPath: '/x/daemon-entry.js',
  appVersion: '1.4.187',
  launchNonce: 'n',
  linuxStartTicks: null,
  bootId: null,
  spawnerExecPath:
    '/Users/alice/Library/Caches/com.stablyai.orca.ShipIt/u/Orca.app/Contents/MacOS/Orca',
  cgroupUnit: null
}
const origin = { app_version_match: 'different', spawner_path_class: 'updater-cache' } as const
const PID_PATH = '/fake/daemon.pid'

beforeEach(() => {
  trackMock.mockReset()
  resetDaemonFolderAccessMismatchForTests()
  opendirMock.mockReset().mockReturnValue(readableDir())
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

describe('hasDaemonPtyCwdDenialDiverged', () => {
  it('is true only when the daemon was denied and this process can enumerate the same cwd', async () => {
    expect(await hasDaemonPtyCwdDenialDiverged(DENIED_CWD, false)).toBe(true)
    expect(opendirMock).toHaveBeenCalledWith(DENIED_CWD)
  })

  // False positives would drown the signal this event exists to measure, so every
  // non-divergent shape must stay silent — including daemons too old to report.
  it('is false when the daemon could read the cwd or did not report one', async () => {
    expect(await hasDaemonPtyCwdDenialDiverged(DENIED_CWD, true)).toBe(false)
    expect(await hasDaemonPtyCwdDenialDiverged(DENIED_CWD, undefined)).toBe(false)
    expect(await hasDaemonPtyCwdDenialDiverged(undefined, false)).toBe(false)
    expect(opendirMock).not.toHaveBeenCalled()
  })

  it('is false when this process cannot enumerate it either (no divergence)', async () => {
    opendirMock.mockImplementation(() => failWith('EACCES'))
    expect(await hasDaemonPtyCwdDenialDiverged(DENIED_CWD, false)).toBe(false)
  })

  it('is false when the cwd is gone rather than refused', async () => {
    opendirMock.mockImplementation(() => failWith('ENOENT'))
    expect(await hasDaemonPtyCwdDenialDiverged(DENIED_CWD, false)).toBe(false)
  })

  it('is false off macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(await hasDaemonPtyCwdDenialDiverged('/home/alice/Documents/repo', false)).toBe(false)
    expect(opendirMock).not.toHaveBeenCalled()
  })
})

describe('trackDaemonPtyCwdDenied', () => {
  it('emits a validator-accepted payload', () => {
    trackDaemonPtyCwdDenied(DENIED_CWD, PID_PATH)
    expect(trackMock).toHaveBeenCalledTimes(1)
    const [name, props] = trackMock.mock.calls[0]
    expect(name).toBe('daemon_pty_cwd_denied')
    expect(props).toEqual({ cwd_class: 'documents', ...origin })
    expect(validate('daemon_pty_cwd_denied', props).ok).toBe(true)
  })

  it('attributes the denial to the daemon recorded right now, not a startup snapshot', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        ...stalePidRecord,
        appVersion: '1.4.191',
        spawnerExecPath: '/Applications/Orca.app/Contents/MacOS/Orca'
      })
    )
    trackDaemonPtyCwdDenied(DENIED_CWD, PID_PATH)
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
    expect(() => trackDaemonPtyCwdDenied(DENIED_CWD, PID_PATH)).not.toThrow()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('swallows a throwing telemetry client', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    expect(() => trackDaemonPtyCwdDenied(DENIED_CWD, PID_PATH)).not.toThrow()
  })
})

describe('reportDaemonPtyCwdVerdict', () => {
  it('emits the event and records the notice evidence on one directory read', async () => {
    await reportDaemonPtyCwdVerdict({
      cwd: DENIED_CWD,
      cwdReadableByDaemon: false,
      pidPath: PID_PATH,
      daemonIdentity: DAEMON
    })

    expect(opendirMock).toHaveBeenCalledTimes(1)
    expect(trackMock.mock.calls[0][0]).toBe('daemon_pty_cwd_denied')
    expect(getDaemonFolderAccessMismatch(DAEMON)?.cwdClass).toBe('documents')
  })

  it('retires the evidence when the same daemon later reads a cwd it owns', async () => {
    await reportDaemonPtyCwdVerdict({
      cwd: DENIED_CWD,
      cwdReadableByDaemon: false,
      pidPath: PID_PATH,
      daemonIdentity: DAEMON
    })
    await reportDaemonPtyCwdVerdict({
      cwd: DENIED_CWD,
      cwdReadableByDaemon: true,
      pidPath: PID_PATH,
      daemonIdentity: DAEMON
    })

    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('does nothing for a daemon that never reported a verdict', async () => {
    await reportDaemonPtyCwdVerdict({
      cwd: DENIED_CWD,
      cwdReadableByDaemon: undefined,
      pidPath: PID_PATH,
      daemonIdentity: DAEMON
    })

    expect(trackMock).not.toHaveBeenCalled()
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('records nothing when the daemon identity is unknown, and never rejects', async () => {
    await expect(
      reportDaemonPtyCwdVerdict({
        cwd: DENIED_CWD,
        cwdReadableByDaemon: false,
        pidPath: PID_PATH,
        daemonIdentity: null
      })
    ).resolves.toBeUndefined()
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('swallows a throwing telemetry client instead of failing the spawn', async () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    await expect(
      reportDaemonPtyCwdVerdict({
        cwd: DENIED_CWD,
        cwdReadableByDaemon: false,
        pidPath: PID_PATH,
        daemonIdentity: DAEMON
      })
    ).resolves.toBeUndefined()
  })

  // The read behind this can sit on an unanswered macOS folder prompt, and a spawn that waited
  // for it would hold main's event loop for as long as the user leaves the sheet up.
  it('records nothing until the app-side read resolves, and the spawn need not wait', async () => {
    let release: (dir: ReturnType<typeof readableDir>) => void = () => {}
    opendirMock.mockReturnValue(
      new Promise<ReturnType<typeof readableDir>>((resolve) => {
        release = resolve
      })
    )

    const pending = reportDaemonPtyCwdVerdict({
      cwd: DENIED_CWD,
      cwdReadableByDaemon: false,
      pidPath: PID_PATH,
      daemonIdentity: DAEMON
    })

    expect(trackMock).not.toHaveBeenCalled()
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()

    release(readableDir())
    await pending

    expect(getDaemonFolderAccessMismatch(DAEMON)?.cwdClass).toBe('documents')
  })
})
