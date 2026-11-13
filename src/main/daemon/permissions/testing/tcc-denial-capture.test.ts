import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMock, logVerdictMock, writeFileMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  logVerdictMock: vi.fn(),
  writeFileMock: vi.fn()
}))
vi.mock('../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../tcc-denial-log-verdict', () => ({ readTccLogVerdict: logVerdictMock }))
vi.mock('../tcc-denial-diagnostics-file', () => ({ writeTccDenialDiagnostics: writeFileMock }))
vi.mock('../tcc-denial-signature-checks', () => ({
  checkHelperSignatures: async () => ({ live: 'pass', diskCopy: 'fail' })
}))
vi.mock('../daemon-full-disk-access-status', () => ({
  getTerminalHostsFullDiskAccessStatus: async () => 'denied'
}))
vi.mock('../../executable-host/macos/daemon-mac-code-identity', () => ({
  inspectMacProcessCodeIdentity: async () => ({ identity: 'resolved', executablePath: null })
}))

import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import {
  noteHelperFolderReadable,
  prepareTccDenialCapture,
  releaseTccDenialCapture,
  resetTccDenialCaptureForTests,
  runTccDenialCapture
} from '../tcc-denial-capture'

const HELPER: DaemonEndpointIdentity = { pid: 1206, startedAtMs: 1_000, launchNonce: 'n1' }
const FOLDER = async () => ({ dataless: 'yes', icloud: 'yes', volumeType: 'apfs' }) as const

beforeEach(() => {
  resetTccDenialCaptureForTests()
  trackMock.mockReset()
  writeFileMock.mockReset().mockResolvedValue(undefined)
  logVerdictMock.mockReset().mockResolvedValue({
    logAccess: 'ok',
    tccdAsked: 'no',
    authValue: 'none',
    authReason: 'none',
    service: 'none',
    requirementFailure: 'no',
    kernelDeny: 'yes',
    lines: ['raw line']
  })
})

describe('tcc denial capture', () => {
  it('captures once per helper incarnation and folder class', async () => {
    const start = await prepareTccDenialCapture(HELPER, 'documents', 5_000, FOLDER)
    expect(start).not.toBeNull()
    await runTccDenialCapture(start!)
    await runTccDenialCapture(start!)

    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(await prepareTccDenialCapture(HELPER, 'documents', 6_000, FOLDER)).toBeNull()
    expect(await prepareTccDenialCapture(HELPER, 'desktop', 6_000, FOLDER)).not.toBeNull()
    expect(
      await prepareTccDenialCapture({ ...HELPER, launchNonce: 'n2' }, 'documents', 6_000, FOLDER)
    ).not.toBeNull()
  })

  it('probes the folder once for concurrent denials, and again only after a release', async () => {
    const readFolder = vi.fn(FOLDER)
    const starts = await Promise.all(
      Array.from({ length: 5 }, () =>
        prepareTccDenialCapture(HELPER, 'documents', 5_000, readFolder)
      )
    )
    expect(readFolder).toHaveBeenCalledTimes(1)
    expect(starts.filter((start) => start !== null)).toHaveLength(1)

    releaseTccDenialCapture(starts.find((start) => start !== null)!)
    expect(await prepareTccDenialCapture(HELPER, 'documents', 6_000, readFolder)).not.toBeNull()
  })

  it('sends enums only, with earlier good reads of the same class on this helper', async () => {
    noteHelperFolderReadable(HELPER, 'documents', 2_000)
    noteHelperFolderReadable(HELPER, 'documents', 3_000)
    noteHelperFolderReadable(HELPER, 'desktop', 4_500)

    await runTccDenialCapture((await prepareTccDenialCapture(HELPER, 'documents', 65_000, FOLDER))!)

    expect(trackMock).toHaveBeenCalledWith(
      'daemon_pty_cwd_denial_capture',
      expect.objectContaining({
        cwd_class: 'documents',
        kernel_deny: 'yes',
        live_signature: 'pass',
        disk_copy_signature: 'fail',
        helper_age_bucket: '1-10m',
        helper_origin: 'adopted',
        good_reads_bucket: '2-5',
        since_good_read_bucket: '1-5m',
        full_disk_access: 'denied',
        fork_fallback: 'unknown',
        folder_dataless: 'yes',
        folder_icloud: 'yes',
        volume_type: 'apfs'
      })
    )
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ helperPid: 1206, logLines: ['raw line'] })
    )
  })

  it('swallows a failing probe and does not retry the same helper and class', async () => {
    logVerdictMock.mockRejectedValue(new Error('log exploded'))
    const start = (await prepareTccDenialCapture(HELPER, 'downloads', 5_000, FOLDER))!

    await expect(runTccDenialCapture(start)).resolves.toBeUndefined()
    expect(trackMock).not.toHaveBeenCalled()
    expect(await prepareTccDenialCapture(HELPER, 'downloads', 6_000, FOLDER)).toBeNull()
  })

  it('still captures when the folder state cannot be read', async () => {
    const start = await prepareTccDenialCapture(HELPER, 'desktop', 5_000, async () => {
      throw new Error('stat failed')
    })
    expect(start?.folderState).toEqual({
      dataless: 'unknown',
      icloud: 'unknown',
      volumeType: 'unknown'
    })
  })
})
