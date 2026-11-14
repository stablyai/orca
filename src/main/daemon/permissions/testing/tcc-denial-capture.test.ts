import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  telemetryEnabled: vi.fn(),
  logVerdict: vi.fn(),
  signatures: vi.fn(),
  fullDiskAccess: vi.fn(),
  codeIdentity: vi.fn(),
  runProcess: vi.fn()
}))
const trackMock = mocks.track
const telemetryEnabledMock = mocks.telemetryEnabled
const logVerdictMock = mocks.logVerdict
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('../../../telemetry/client', () => ({
  track: mocks.track,
  isTelemetryEnabled: mocks.telemetryEnabled
}))
vi.mock('../tcc-denial-log-verdict', () => ({ readTccLogVerdict: mocks.logVerdict }))
vi.mock('../tcc-denial-signature-checks', () => ({ checkHelperSignatures: mocks.signatures }))
vi.mock('../daemon-full-disk-access-status', () => ({
  getTerminalHostsFullDiskAccessStatus: mocks.fullDiskAccess
}))
vi.mock('../../executable-host/macos/daemon-mac-code-identity', () => ({
  inspectMacProcessCodeIdentity: mocks.codeIdentity
}))

import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import type { readTccFolderState } from '../tcc-denial-folder-state'
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
  telemetryEnabledMock.mockReset().mockReturnValue(true)
  mocks.signatures.mockReset().mockResolvedValue({ live: 'pass', diskCopy: 'fail' })
  mocks.fullDiskAccess.mockReset().mockResolvedValue('denied')
  mocks.codeIdentity.mockReset().mockResolvedValue({ identity: 'resolved', executablePath: null })
  mocks.runProcess.mockReset().mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  logVerdictMock.mockReset().mockResolvedValue({
    logAccess: 'ok',
    tccdAsked: 'no',
    authValue: 'none',
    authReason: 'none',
    service: 'none',
    requirementFailure: 'no',
    kernelDeny: 'yes'
  })
})

describe('tcc denial capture', () => {
  it('runs no probe or log read for a user who opted out of telemetry', async () => {
    telemetryEnabledMock.mockReturnValue(false)
    const readFolder = vi.fn(FOLDER)
    expect(await prepareTccDenialCapture(HELPER, 'documents', 5_000, readFolder)).toBeNull()
    expect(readFolder).not.toHaveBeenCalled()

    // Opting out while the app-side read waits stops the capture before the log is read.
    telemetryEnabledMock.mockReturnValue(true)
    const start = (await prepareTccDenialCapture(HELPER, 'documents', 5_000, FOLDER))!
    telemetryEnabledMock.mockReturnValue(false)
    await runTccDenialCapture(start)
    expect(logVerdictMock).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })

  // Opt out while each stage is in flight: nothing after it may start, and the claim is freed.
  it.each([
    {
      stage: 'identity probe',
      probe: mocks.codeIdentity,
      result: { identity: 'resolved', executablePath: null },
      skipped: [mocks.logVerdict, mocks.signatures, mocks.fullDiskAccess]
    },
    {
      // The access reader is lazily imported, so it starts after an await of its own.
      stage: 'log reader, before the lazily imported access reader',
      probe: mocks.logVerdict,
      result: {
        logAccess: 'ok',
        tccdAsked: 'no',
        authValue: 'none',
        authReason: 'none',
        service: 'none',
        requirementFailure: 'no',
        kernelDeny: 'no'
      },
      skipped: [mocks.fullDiskAccess]
    },
    {
      stage: 'log, signature and access probes',
      probe: mocks.signatures,
      result: { live: 'pass', diskCopy: 'pass' },
      skipped: []
    }
  ])('stops after the $stage when telemetry is turned off', async ({ probe, result, skipped }) => {
    const start = (await prepareTccDenialCapture(HELPER, 'documents', 5_000, FOLDER))!
    probe.mockImplementationOnce(async () => {
      telemetryEnabledMock.mockReturnValue(false)
      return result
    })
    await runTccDenialCapture(start)

    for (const probe of skipped) {
      expect(probe).not.toHaveBeenCalled()
    }
    expect(trackMock).not.toHaveBeenCalled()
    telemetryEnabledMock.mockReturnValue(true)
    expect(await prepareTccDenialCapture(HELPER, 'documents', 6_000, FOLDER)).not.toBeNull()
  })

  it('stops after the folder probes when telemetry is turned off', async () => {
    const readFolder = vi.fn(async () => {
      telemetryEnabledMock.mockReturnValue(false)
      return FOLDER()
    })
    expect(await prepareTccDenialCapture(HELPER, 'documents', 5_000, readFolder)).toBeNull()
    telemetryEnabledMock.mockReturnValue(true)
    expect(await prepareTccDenialCapture(HELPER, 'documents', 6_000, FOLDER)).not.toBeNull()
  })

  it('hands every probe a runner that refuses to spawn once telemetry is off', async () => {
    const readFolder = vi.fn<typeof readTccFolderState>(FOLDER)
    await prepareTccDenialCapture(HELPER, 'documents', 5_000, readFolder)
    const runner = readFolder.mock.calls[0][2]

    await runner({ program: '/usr/bin/true' })
    telemetryEnabledMock.mockReturnValue(false)
    await expect(runner({ program: '/usr/bin/true' })).rejects.toThrow('telemetry is off')
    expect(mocks.runProcess).toHaveBeenCalledTimes(1)
  })

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
