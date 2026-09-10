import { afterEach, describe, expect, it } from 'vitest'
import type * as pty from 'node-pty'
import { createPtyStopReceipt } from '../../shared/pty-stop-receipt'
import {
  constrainWindowsJobObjectStopReceipt,
  forgetWindowsPtyJobObjectOwner,
  hasWindowsPtyJobObjectOwnership,
  registerWindowsPtyJobObjectOwner,
  releaseWindowsPtyJobObjectOwner,
  upgradeWindowsPtyJobObjectStopReceipt
} from './windows-pty-job-object'

const ownerId = 'session-1'

function processWithJob(receipt: unknown = undefined): pty.IPty {
  return {
    pid: 41,
    windowsJobObjectAssigned: true,
    windowsJobObjectStopReceipt: receipt
  } as unknown as pty.IPty
}

function fallbackReceipt() {
  const root = { pid: 41, parentPid: null, processGroupId: null, startedAt: null }
  return createPtyStopReceipt({
    executionHostId: 'local',
    terminalHandle: ownerId,
    ptyId: ownerId,
    ptyIncarnation: 'incarnation-1',
    root,
    descendants: [],
    observations: [
      { identity: root, status: 'unverifiable', observedAt: new Date().toISOString() }
    ],
    verdict: 'capability_limited',
    processTreeVerified: false,
    reason: 'legacy_windows_fallback'
  })
}

describe('Windows PTY Job Object ownership', () => {
  afterEach(() => forgetWindowsPtyJobObjectOwner(ownerId))

  it('gates ownership to native Windows sessions outside WSL', () => {
    const process = processWithJob()
    expect(hasWindowsPtyJobObjectOwnership(process, { platform: 'linux' })).toBe(false)
    expect(hasWindowsPtyJobObjectOwnership(process, { platform: 'win32', isWsl: true })).toBe(false)
    expect(hasWindowsPtyJobObjectOwnership(process, { platform: 'win32' })).toBe(true)
  })

  it('keeps old peers capability-limited', () => {
    expect(
      constrainWindowsJobObjectStopReceipt(fallbackReceipt(), {
        supported: false,
        platform: 'win32',
        isWsl: false
      })
    ).toMatchObject({
      verdict: 'capability_limited',
      processTreeVerified: false
    })
  })

  it('withholds exact capability at the WSL boundary', () => {
    expect(
      constrainWindowsJobObjectStopReceipt(fallbackReceipt(), {
        supported: true,
        platform: 'win32',
        isWsl: true
      })
    ).toMatchObject({ verdict: 'capability_limited', processTreeVerified: false })
  })

  it('rejects malformed or PID-reused native evidence', () => {
    const process = processWithJob({
      version: 1,
      assigned: true,
      processTreeVerified: true,
      identities: [
        { pid: 41, parentPid: null, processGroupId: null, startedAt: 'first' },
        { pid: 41, parentPid: null, processGroupId: null, startedAt: 'reused' }
      ]
    })
    registerWindowsPtyJobObjectOwner(ownerId, process, { platform: 'win32' })
    expect(upgradeWindowsPtyJobObjectStopReceipt(ownerId, fallbackReceipt()).verdict).toBe(
      'capability_limited'
    )
  })

  it('retains exact evidence across native handle disposal', () => {
    const process = processWithJob({
      version: 1,
      assigned: true,
      processTreeVerified: true,
      identities: [
        { pid: 41, parentPid: null, processGroupId: null, startedAt: 'root-created' },
        { pid: 42, parentPid: null, processGroupId: null, startedAt: 'child-created' }
      ]
    })
    registerWindowsPtyJobObjectOwner(ownerId, process, { platform: 'win32' })
    releaseWindowsPtyJobObjectOwner(ownerId)

    expect(upgradeWindowsPtyJobObjectStopReceipt(ownerId, fallbackReceipt())).toMatchObject({
      verdict: 'exited',
      processTreeVerified: true,
      descendants: [{ pid: 42, startedAt: 'child-created' }]
    })
  })

  it('fails closed when assignment evidence is unavailable', () => {
    registerWindowsPtyJobObjectOwner(ownerId, processWithJob(), { platform: 'win32' })
    expect(upgradeWindowsPtyJobObjectStopReceipt(ownerId, fallbackReceipt()).verdict).toBe(
      'capability_limited'
    )
  })
})
