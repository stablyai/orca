import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../macos-permissions/macos-tcc-reset', () => ({
  readMacosBundleId: readMacosBundleIdMock,
  resetMacosTccPermission: resetMacosTccPermissionMock
}))
vi.mock('../daemon-folder-access-mismatch', () => ({
  getDaemonFolderAccessTarget: getTargetMock,
  getDaemonFolderAccessMismatch: getMismatchMock,
  refreshDaemonFolderAccessProbe: refreshProbeMock
}))

import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import { resetFolderAccessForDaemon } from '../daemon-folder-access-reset'

const DAEMON: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }
const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

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
  it('reports a refused tccutil without touching the folder', async () => {
    resetMacosTccPermissionMock.mockResolvedValue({ ok: false, detail: 'exit 64' })

    expect(await resetFolderAccessForDaemon(DAEMON)).toEqual({ outcome: 'reset_failed' })
    expect(opendirMock).not.toHaveBeenCalled()
    expect(refreshProbeMock).not.toHaveBeenCalled()
  })
})

describe('resetFolderAccessForDaemon runs the remedy', () => {
  // An unanswered TCC prompt can block the read indefinitely.
  it('stops waiting on an unanswered prompt, and does not probe under the sheet', async () => {
    const denied = {
      daemonScope: 'aaaa111122223333',
      cwdClass: 'documents',
      freshDaemonAccess: 'denied'
    }
    let answer: () => void = () => {}
    opendirMock.mockReturnValue(
      new Promise((resolve) => {
        answer = () => resolve(fakeDir())
      })
    )
    getMismatchMock.mockReturnValue(denied)
    vi.useFakeTimers()
    try {
      const pending = resetFolderAccessForDaemon(DAEMON)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)

      // The stored verdict predates the reset.
      expect(await pending).toEqual({
        outcome: 'probed',
        mismatch: { ...denied, freshDaemonAccess: 'unknown' }
      })
      expect(refreshProbeMock).not.toHaveBeenCalled()
      expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
        action: 'reset_outcome_unknown',
        cwd_class: 'documents'
      })
    } finally {
      answer()
      await vi.advanceTimersByTimeAsync(0)
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
})
