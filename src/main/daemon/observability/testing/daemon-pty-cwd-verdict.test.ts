import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { enumerateMock } = vi.hoisted(() => ({ enumerateMock: vi.fn() }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../permissions/directory-enumeration-probe', () => ({
  enumerateDirectoryOnce: enumerateMock
}))

import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import {
  getDaemonFolderAccessMismatch,
  resetDaemonFolderAccessMismatchForTests
} from '../../permissions/daemon-folder-access-mismatch'
import { reportDaemonPtyCwdVerdict } from '../daemon-adoption-telemetry-event'

const HELPER: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }
const FOLDER = '/work/orca-cwd-verdict/repo'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function verdict(cwdReadableByDaemon: boolean, cwd = FOLDER): Promise<void> {
  return reportDaemonPtyCwdVerdict({
    cwd,
    cwdReadableByDaemon,
    pidPath: null,
    daemonIdentity: HELPER
  })
}

beforeEach(() => {
  resetDaemonFolderAccessMismatchForTests()
  enumerateMock.mockReset()
  // The app-side recheck only runs on macOS; the ordering rule itself is platform-free.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
})

describe('helper folder verdicts', () => {
  it('keeps a re-allow when an older denial finishes its app-side recheck afterwards', async () => {
    let finishRecheck: (outcome: string) => void = () => {}
    enumerateMock.mockReturnValueOnce(new Promise((resolve) => (finishRecheck = resolve)))
    const denial = verdict(false)
    await verdict(true)
    finishRecheck('ok')
    await denial
    expect(getDaemonFolderAccessMismatch(HELPER)).toBeNull()
  })

  it('keeps an older denial when a later one is for a folder this app cannot read either', async () => {
    let finishRecheck: (outcome: string) => void = () => {}
    enumerateMock
      .mockReturnValueOnce(new Promise((resolve) => (finishRecheck = resolve)))
      .mockResolvedValueOnce('denied')
    const denial = verdict(false)
    await verdict(false, '/work/orca-cwd-verdict/other')
    finishRecheck('ok')
    await denial
    expect(getDaemonFolderAccessMismatch(HELPER)).not.toBeNull()
  })
})
