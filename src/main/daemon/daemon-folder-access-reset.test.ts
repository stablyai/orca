import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validate } from '../telemetry/validator'

const {
  trackMock,
  getPathMock,
  opendirMock,
  readMacosBundleIdMock,
  resetMacosTccPermissionMock,
  getTargetMock,
  getMismatchMock,
  refreshProbeMock
} = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getPathMock: vi.fn(() => '/Applications/Orca.app/Contents/MacOS/Orca'),
  opendirMock: vi.fn(),
  readMacosBundleIdMock: vi.fn<() => Promise<string | null>>(async () => 'com.stablyai.orca'),
  resetMacosTccPermissionMock: vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({
    ok: true
  })),
  getTargetMock: vi.fn<() => { canonicalPath: string; cwdClass: string } | null>(() => null),
  getMismatchMock: vi.fn<
    () => { daemonScope: string; cwdClass: string; freshDaemonAccess: string } | null
  >(() => null),
  refreshProbeMock: vi.fn(async () => {})
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('node:fs/promises', () => ({ opendir: opendirMock }))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../macos-tcc-reset', () => ({
  readMacosBundleId: readMacosBundleIdMock,
  resetMacosTccPermission: resetMacosTccPermissionMock
}))
vi.mock('./daemon-folder-access-mismatch', () => ({
  getDaemonFolderAccessTarget: getTargetMock,
  getDaemonFolderAccessMismatch: getMismatchMock,
  refreshDaemonFolderAccessProbe: refreshProbeMock
}))

import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import { resetFolderAccessForDaemon } from './daemon-folder-access-reset'

const DAEMON: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }
const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

/** The folder handle the app opens to provoke the prompt; `read` then `close`, both awaited. */
function fakeDir(): { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => null), close: vi.fn(async () => {}) }
}

beforeEach(() => {
  setPlatform('darwin')
  trackMock.mockReset()
  getPathMock.mockReset().mockReturnValue('/Applications/Orca.app/Contents/MacOS/Orca')
  opendirMock.mockReset().mockResolvedValue(fakeDir())
  readMacosBundleIdMock.mockReset().mockResolvedValue('com.stablyai.orca')
  resetMacosTccPermissionMock.mockReset().mockResolvedValue({ ok: true })
  getTargetMock
    .mockReset()
    .mockReturnValue({ canonicalPath: '/Users/alice/Documents/repo', cwdClass: 'documents' })
  getMismatchMock.mockReset().mockReturnValue(null)
  refreshProbeMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('resetFolderAccessForDaemon rejects cases it cannot remedy', () => {
  it('is unsupported off macOS, where there is no TCC row to clear', async () => {
    setPlatform('win32')

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'unsupported' })
    expect(resetMacosTccPermissionMock).not.toHaveBeenCalled()
  })

  it('is unsupported when no evidence belongs to this daemon', async () => {
    getTargetMock.mockReturnValue(null)

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'unsupported' })
    expect(resetMacosTccPermissionMock).not.toHaveBeenCalled()
  })

  // Only Documents/Desktop/Downloads have a per-app TCC row; the rest have nothing to reset.
  it.each([['other-home'], ['outside-home']])(
    'is unsupported for the %s folder class',
    async (cwdClass) => {
      getTargetMock.mockReturnValue({ canonicalPath: '/Users/alice/code', cwdClass })

      expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'unsupported' })
      expect(resetMacosTccPermissionMock).not.toHaveBeenCalled()
    }
  )

  it('is unsupported when the running bundle has no readable identifier', async () => {
    readMacosBundleIdMock.mockResolvedValue(null)

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'unsupported' })
    expect(resetMacosTccPermissionMock).not.toHaveBeenCalled()
  })

  it('reports a refused tccutil without touching the folder', async () => {
    resetMacosTccPermissionMock.mockResolvedValue({ ok: false, detail: 'exit 64' })

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'reset_failed' })
    expect(opendirMock).not.toHaveBeenCalled()
    expect(refreshProbeMock).not.toHaveBeenCalled()
  })
})

describe('resetFolderAccessForDaemon runs the remedy', () => {
  it.each([
    ['documents', 'SystemPolicyDocumentsFolder'],
    ['desktop', 'SystemPolicyDesktopFolder'],
    ['downloads', 'SystemPolicyDownloadsFolder']
  ])('clears the %s row against the running app bundle', async (cwdClass, service) => {
    getTargetMock.mockReturnValue({ canonicalPath: '/Users/alice/Documents/repo', cwdClass })

    await resetFolderAccessForDaemon(DAEMON)

    expect(readMacosBundleIdMock).toHaveBeenCalledWith('/Applications/Orca.app')
    expect(resetMacosTccPermissionMock).toHaveBeenCalledWith(service, 'com.stablyai.orca')
  })

  // The prompt is attributed to whoever makes the syscall, so the app has to be what reads it.
  it('reads the folder from the app, then forces a fresh-daemon re-probe', async () => {
    const dir = fakeDir()
    opendirMock.mockResolvedValue(dir)

    await resetFolderAccessForDaemon(DAEMON)

    expect(opendirMock).toHaveBeenCalledWith('/Users/alice/Documents/repo')
    expect(dir.read).toHaveBeenCalledTimes(1)
    expect(dir.close).toHaveBeenCalledTimes(1)
    expect(refreshProbeMock).toHaveBeenCalledWith(DAEMON, { force: true })
  })

  it('still re-probes when the folder read is itself denied', async () => {
    opendirMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }))
    getMismatchMock.mockReturnValue({
      daemonScope: 'aaaa111122223333',
      cwdClass: 'documents',
      freshDaemonAccess: 'denied'
    })

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({
      outcome: 'probed',
      mismatch: {
        daemonScope: 'aaaa111122223333',
        cwdClass: 'documents',
        freshDaemonAccess: 'denied'
      }
    })
    expect(refreshProbeMock).toHaveBeenCalledWith(DAEMON, { force: true })
  })

  // An unanswered TCC sheet blocks the read for as long as the user ignores it, and the dialog is
  // modal and busy the whole time.
  it('stops waiting on an unanswered prompt, and does not probe under the sheet', async () => {
    const denied = {
      daemonScope: 'aaaa111122223333',
      cwdClass: 'documents',
      freshDaemonAccess: 'denied'
    }
    opendirMock.mockReturnValue(new Promise<never>(() => {}))
    getMismatchMock.mockReturnValue(denied)
    vi.useFakeTimers()
    try {
      const pending = resetFolderAccessForDaemon(DAEMON)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)

      // The stored verdict predates the reset, so it is not the reset's answer.
      expect(await pending).toEqual({
        outcome: 'probed',
        mismatch: { ...denied, freshDaemonAccess: 'unknown' }
      })
      expect(refreshProbeMock).not.toHaveBeenCalled()
      // Nothing probed the folder after the reset, so the outcome is not a verdict.
      expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
        action: 'reset_outcome_unknown',
        cwd_class: 'documents'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps waiting inside the deadline and probes once the prompt is answered', async () => {
    let answer: () => void = () => {}
    opendirMock.mockReturnValue(
      new Promise((resolve) => {
        answer = () => resolve(fakeDir())
      })
    )
    vi.useFakeTimers()
    try {
      const pending = resetFolderAccessForDaemon(DAEMON)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(refreshProbeMock).not.toHaveBeenCalled()

      answer()
      await vi.advanceTimersByTimeAsync(0)
      await pending

      expect(refreshProbeMock).toHaveBeenCalledWith(DAEMON, { force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the handle even when the read throws', async () => {
    const dir = fakeDir()
    dir.read.mockRejectedValue(new Error('EPERM'))
    opendirMock.mockResolvedValue(dir)

    await resetFolderAccessForDaemon(DAEMON)

    expect(dir.close).toHaveBeenCalledTimes(1)
  })
})

// Nobody has verified this remedy on an affected machine, so the re-probe's verdict is the
// feature's only evidence. It must leave main as a valid event every time.
describe('resetFolderAccessForDaemon reports the outcome', () => {
  it.each([
    ['allowed', 'reset_outcome_allowed'],
    ['denied', 'reset_outcome_still_denied'],
    ['unknown', 'reset_outcome_unknown']
  ])('emits %s as %s', async (freshDaemonAccess, action) => {
    getMismatchMock.mockReturnValue({
      daemonScope: 'aaaa111122223333',
      cwdClass: 'documents',
      freshDaemonAccess
    })

    await resetFolderAccessForDaemon(DAEMON)

    expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action,
      cwd_class: 'documents'
    })
    expect(validate('daemon_folder_access_notice', trackMock.mock.calls[0][1]).ok).toBe(true)
  })

  it('treats a retired entry as an unknown outcome', async () => {
    getMismatchMock.mockReturnValue(null)

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'probed', mismatch: null })
    expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'reset_outcome_unknown',
      cwd_class: 'documents'
    })
  })

  it('completes the reset even when telemetry throws', async () => {
    trackMock.mockImplementation(() => {
      throw new Error('no transport')
    })

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'probed', mismatch: null })
  })
})
