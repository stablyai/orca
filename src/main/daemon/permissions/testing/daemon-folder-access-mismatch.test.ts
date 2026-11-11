import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMock, probeMock } = vi.hoisted(() => ({ trackMock: vi.fn(), probeMock: vi.fn() }))
vi.mock('../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../daemon-folder-access-probe', () => ({
  probeFolderAccessForFreshDaemon: probeMock
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => '/Users/alice'
}))

import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import {
  getDaemonFolderAccessMismatch,
  recordDaemonFolderAccessMismatch,
  refreshDaemonFolderAccessProbe,
  resetDaemonFolderAccessMismatchForTests
} from '../daemon-folder-access-mismatch'

const DAEMON: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }
const DOCUMENTS = '/Users/alice/Documents/repo'

beforeEach(() => {
  resetDaemonFolderAccessMismatchForTests()
  trackMock.mockReset()
  probeMock.mockReset().mockResolvedValue('unknown')
  vi.useRealTimers()
})

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('freshDaemonAccess', () => {
  it('drops a probe whose entry was replaced while the child ran', async () => {
    let release: (value: string) => void = () => {}
    probeMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve
      })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    void refreshDaemonFolderAccessProbe(DAEMON)

    probeMock.mockResolvedValue('denied')
    recordDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Desktop/other')
    const forced = refreshDaemonFolderAccessProbe(DAEMON, { force: true })
    release('ok')
    await forced

    const notice = getDaemonFolderAccessMismatch(DAEMON)
    expect(notice?.cwdClass).toBe('desktop')
    expect(notice?.freshDaemonAccess).toBe('denied')
  })
})

describe('refreshDaemonFolderAccessProbe', () => {
  // A pre-reset probe must not win over the forced probe that observes the remedy.
  it('waits for an older in-flight probe and still lands its own verdict', async () => {
    const releases: ((value: string) => void)[] = []
    probeMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve)
        })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    void refreshDaemonFolderAccessProbe(DAEMON)

    const forced = refreshDaemonFolderAccessProbe(DAEMON, { force: true })
    releases[0]('denied')
    await settleProbe()
    releases[1]('ok')
    await forced

    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('allowed')
  })
})
