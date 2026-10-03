import { capturePtyAgentPresence } from '../daemon/pty-subprocess/pty-agent-presence'
import type { IPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureWindowsAgentPresence,
  probeWindowsAgentPresence,
  windowsAgentPresenceProofEnabled
} from './windows-agent-presence'
const native = vi.hoisted(() => ({ creation: vi.fn(), members: vi.fn() }))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessCreationTime: native.creation
}))
vi.mock('./windows-pty-job-membership', () => ({ readWindowsPtyJobProcessIds: native.members }))
const consoleAttached = vi.hoisted(() => vi.fn())
vi.mock('./windows-console-attached-processes', () => ({
  readWindowsConsoleAttachedProcessIds: consoleAttached
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('ORCA_WINDOWS_AGENT_PRESENCE_PROOF', '1')
  native.creation.mockReset().mockReturnValue(100)
  native.members.mockReset().mockReturnValue(new Set([10, 42]))
  consoleAttached.mockReset().mockResolvedValue(new Set([10, 42]))
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mocked job reads never access any IPty member beyond this test's PID.
const proc = { pid: 10 } as IPty
const observation = {
  available: true,
  processName: 'codex',
  processId: 42,
  processStartTime: '100'
}
const owner = { pid: 42, platform: 'win32', startTime: '100' } as const

describe('per-PTY Windows job exit proof', () => {
  it('keeps the job adapter disabled without the explicit proof capability', () => {
    vi.stubEnv('ORCA_WINDOWS_AGENT_PRESENCE_PROOF', '')
    try {
      expect(windowsAgentPresenceProofEnabled()).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('admits only the cached lifetime still in the terminal job', async () => {
    expect(await captureWindowsAgentPresence(proc, observation)).toMatchObject({ process: owner })
    expect(native.creation.mock.calls).toEqual([[42], [42]])
    expect(native.members).toHaveBeenCalledTimes(2)
  })
  it('refuses a job member detached from this console (Start-Process), once per capture', async () => {
    consoleAttached.mockResolvedValue(new Set([10]))
    expect(await captureWindowsAgentPresence(proc, observation)).toBeUndefined()
    consoleAttached.mockResolvedValue(null)
    expect(await captureWindowsAgentPresence(proc, observation)).toBeUndefined()
    expect(consoleAttached).toHaveBeenCalledTimes(2)
    expect(consoleAttached).toHaveBeenCalledWith(10)
  })
  it('refuses a reused cached PID and a job that becomes unprovable during capture', async () => {
    native.creation.mockReturnValue(101)
    expect(await captureWindowsAgentPresence(proc, observation)).toBeUndefined()
    native.creation.mockReturnValue(100)
    native.members.mockReturnValueOnce(new Set([10, 42])).mockReturnValueOnce(null)
    expect(await captureWindowsAgentPresence(proc, observation)).toBeUndefined()
  })
  it('uses only the daemon cache and refuses an expired observation', async () => {
    const resolver = vi.fn()
    const cached = {
      processName: 'codex',
      pid: 42,
      processStartTime: '100',
      refreshedAt: Date.now()
    }
    expect(await capturePtyAgentPresence(proc, () => false, cached, resolver)).toMatchObject({
      process: owner
    })
    native.creation.mockClear()
    expect(
      await capturePtyAgentPresence(
        proc,
        () => false,
        { ...cached, refreshedAt: Date.now() - 1_001 },
        resolver
      )
    ).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
    expect(native.creation).not.toHaveBeenCalled()
  })
  it('only a complete membership answer proves absence', () => {
    const read = vi.fn(() => null)
    expect(probeWindowsAgentPresence(owner, null, read)).toBe('unverifiable')
    expect(probeWindowsAgentPresence(owner, new Set([42]), read)).toBe('unverifiable')
    expect(probeWindowsAgentPresence(owner, new Set([10]), read)).toBe('exited')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('retains the matching owner and detects PID reuse', () => {
    expect(probeWindowsAgentPresence(owner, new Set([42]), () => 100)).toBe('live')
    expect(probeWindowsAgentPresence(owner, new Set([42]), () => 101)).toBe('exited')
  })
})
