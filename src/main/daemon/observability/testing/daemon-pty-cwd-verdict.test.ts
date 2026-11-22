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

const NEXT_HELPER: DaemonEndpointIdentity = { pid: 1531, startedAtMs: 1_700_500, launchNonce: 'n2' }

function verdict(cwdReadableByDaemon: boolean, cwd = FOLDER, helper = HELPER): Promise<void> {
  return reportDaemonPtyCwdVerdict({
    cwd,
    cwdReadableByDaemon,
    pidPath: null,
    daemonIdentity: helper
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

  it('keeps the next helper notice when a replaced helper finishes its re-allowed denial', async () => {
    let finishRecheck: (outcome: string) => void = () => {}
    enumerateMock
      .mockReturnValueOnce(new Promise((resolve) => (finishRecheck = resolve)))
      .mockResolvedValueOnce('ok')
    const denial = verdict(false)
    await verdict(true)
    await verdict(true, '/work/orca-cwd-verdict/next', NEXT_HELPER)
    await verdict(false, '/work/orca-cwd-verdict/next', NEXT_HELPER)
    finishRecheck('ok')
    await denial
    expect(getDaemonFolderAccessMismatch(NEXT_HELPER)).not.toBeNull()
  })
})
