import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EndpointIncarnation from './daemon-endpoint-incarnation'

const { divergence, track, readRecord, recordDenial } = vi.hoisted(() => ({
  divergence: vi.fn(() => true),
  track: vi.fn(),
  readRecord: vi.fn(),
  recordDenial: vi.fn()
}))
vi.mock('./daemon-adoption-telemetry-event', () => ({
  isDaemonPtyCwdDenialDiverged: divergence,
  trackDaemonPtyCwdDeniedIfDiverged: track
}))
vi.mock('./daemon-endpoint-incarnation', async (original) => ({
  ...(await original<typeof EndpointIncarnation>()),
  readDaemonPidRecord: readRecord
}))
vi.mock('./daemon-tcc-attribution', () => ({ recordMacDaemonProtectedPathDenial: recordDenial }))
import { handleDaemonPtyCwdDenial } from './daemon-pty-cwd-denial'

const identity = { pid: 123, startedAtMs: 456, launchNonce: 'a' }
const args = {
  cwd: '/folder',
  cwdReadableByDaemon: false,
  spawningIdentity: identity,
  pidPath: '/daemon.pid'
}

beforeEach(() => {
  vi.clearAllMocks()
  divergence.mockReturnValue(true)
  readRecord.mockReturnValue(identity)
})

describe('measured cwd denial', () => {
  it('records evidence and requests degradation before returning the reporting spawn', async () => {
    let complete!: () => void
    const degrade = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = () => resolve(true)
        })
    )
    let returned = false
    const pending = handleDaemonPtyCwdDenial({ ...args, degrade }).then(() => {
      returned = true
    })
    expect(degrade).toHaveBeenCalledOnce()
    expect(recordDenial).toHaveBeenCalledWith(identity, '/daemon.pid')
    expect(returned).toBe(false)
    complete()
    await pending
    expect(divergence).toHaveBeenCalledOnce()
    expect(readRecord).toHaveBeenCalledOnce()
    expect(track).toHaveBeenCalledWith('/folder', false, '/daemon.pid', { pidRecord: identity })
  })

  it('never blames a replacement daemon for the previous daemon’s denial', async () => {
    readRecord.mockReturnValue({ ...identity, launchNonce: 'b' })
    const degrade = vi.fn()
    await handleDaemonPtyCwdDenial({ ...args, degrade })
    expect(recordDenial).not.toHaveBeenCalled()
    expect(degrade).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('/folder', false, '/daemon.pid', { pidRecord: null })
  })

  it('does not read a PID record when access did not diverge', async () => {
    divergence.mockReturnValue(false)
    await handleDaemonPtyCwdDenial({ ...args, degrade: null })
    expect(readRecord).not.toHaveBeenCalled()
    expect(recordDenial).not.toHaveBeenCalled()
  })

  it('preserves the already-spawned session when degradation fails', async () => {
    await expect(
      handleDaemonPtyCwdDenial({
        ...args,
        degrade: async () => {
          throw new Error('restart')
        }
      })
    ).resolves.toBeUndefined()
    expect(recordDenial).toHaveBeenCalledOnce()
  })
})
