import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessTableSnapshotReader from '../../shared/process-table-snapshot-reader'

const { cheapSnapshotMock, fullSnapshotMock, resolveMock } = vi.hoisted(() => ({
  cheapSnapshotMock: vi.fn(),
  fullSnapshotMock: vi.fn(),
  resolveMock: vi.fn()
}))

vi.mock('../../shared/cheap-process-table-snapshot-reader', () => ({
  getCheapProcessTableSnapshot: cheapSnapshotMock
}))
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableSnapshotReader>()),
  getProcessTableSnapshot: fullSnapshotMock
}))
vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: resolveMock,
  confirmShellForegroundProcess: vi.fn()
}))

import { getLocalPtyForegroundProcess } from './local-pty-foreground-inspection'
import { ptyLastRecognizedForeground, ptyProcesses, ptyShellName } from './local-pty-provider-state'

const SHELL_PID = 4242
const AGENT_PID = 4300
const ID = 'pty-1'

type Table = 'agent' | 'shell-only'
let table: Table = 'agent'

function rows(): Record<string, unknown>[] {
  const tpgid = table === 'agent' ? AGENT_PID : SHELL_PID
  const out: Record<string, unknown>[] = [
    {
      pid: SHELL_PID,
      ppid: 1,
      pgid: SHELL_PID,
      tpgid,
      stat: table === 'agent' ? 'Ss' : 'Ss+',
      tty: 'ttys004',
      startTime: 'Thu Sep  3 16:02:01 2026',
      command: '-zsh'
    }
  ]
  if (table === 'agent') {
    out.push({
      pid: AGENT_PID,
      ppid: SHELL_PID,
      pgid: AGENT_PID,
      tpgid,
      stat: 'S+',
      tty: 'ttys004',
      startTime: 'Thu Sep  3 16:02:05 2026',
      command: 'node /usr/local/bin/claude'
    })
  }
  return out
}

describe('local POSIX provider cheap-tier revalidation', () => {
  let platform: PropertyDescriptor | undefined
  const proc = { pid: SHELL_PID, process: 'node' }

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    table = 'agent'
    proc.process = 'node'
    cheapSnapshotMock.mockReset()
    cheapSnapshotMock.mockImplementation(async () => rows())
    fullSnapshotMock.mockReset()
    fullSnapshotMock.mockImplementation(async () => rows())
    resolveMock.mockReset()
    resolveMock.mockImplementation(async () => ({
      available: true,
      processName: table === 'agent' ? 'claude' : 'zsh'
    }))
    ptyProcesses.set(ID, proc as never)
    ptyShellName.set(ID, 'zsh')
    ptyLastRecognizedForeground.delete(ID)
  })

  afterEach(() => {
    ptyProcesses.delete(ID)
    ptyShellName.delete(ID)
    ptyLastRecognizedForeground.delete(ID)
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('a pane with NO recognized anchor never consults the cheap tier', async () => {
    table = 'shell-only'
    proc.process = 'zsh'
    for (let i = 0; i < 3; i += 1) {
      expect(await getLocalPtyForegroundProcess(ID)).toBe('zsh')
    }
    expect(cheapSnapshotMock).not.toHaveBeenCalled()
    expect(resolveMock).toHaveBeenCalledTimes(3)
    expect(ptyLastRecognizedForeground.get(ID)).toBeUndefined()
  })

  it('once recognized, an unchanged pane re-proves the agent from the cheap tier without a full scan', async () => {
    expect(await getLocalPtyForegroundProcess(ID)).toBe('claude')
    expect(resolveMock).toHaveBeenCalledTimes(1)
    expect(ptyLastRecognizedForeground.get(ID)?.steady?.fingerprint).toEqual(expect.any(String))
    for (let i = 0; i < 3; i += 1) {
      expect(await getLocalPtyForegroundProcess(ID)).toBe('claude')
    }
    expect(cheapSnapshotMock).toHaveBeenCalledTimes(3)
    expect(resolveMock).toHaveBeenCalledTimes(1)
  })

  it('an agent exit changes the fingerprint, escalates to the full scan, and clears the anchor', async () => {
    expect(await getLocalPtyForegroundProcess(ID)).toBe('claude')
    table = 'shell-only'
    expect(await getLocalPtyForegroundProcess(ID)).toBe('zsh')
    expect(resolveMock).toHaveBeenCalledTimes(2)
    expect(ptyLastRecognizedForeground.get(ID)).toBeUndefined()
  })

  it('a changed node-pty foreground name escalates without consulting the cheap tier', async () => {
    expect(await getLocalPtyForegroundProcess(ID)).toBe('claude')
    proc.process = 'zsh'
    table = 'shell-only'
    expect(await getLocalPtyForegroundProcess(ID)).toBe('zsh')
    expect(cheapSnapshotMock).not.toHaveBeenCalled()
    expect(resolveMock).toHaveBeenCalledTimes(2)
  })

  it('a cheap capture failure falls through to the full scan', async () => {
    expect(await getLocalPtyForegroundProcess(ID)).toBe('claude')
    cheapSnapshotMock.mockRejectedValueOnce(new Error('ps died'))
    expect(await getLocalPtyForegroundProcess(ID)).toBe('claude')
    expect(resolveMock).toHaveBeenCalledTimes(2)
  })
})
