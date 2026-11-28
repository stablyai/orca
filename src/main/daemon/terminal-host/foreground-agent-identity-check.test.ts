import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSameForegroundAgent } from './foreground-agent-identity-check'

const host = vi.hoisted(() => ({
  creationTimes: new Map<number, number>(),
  tableScans: 0
}))
vi.mock('../../windows/windows-process-table', () => ({
  isWindowsProcessStartTimeAvailable: () => true,
  readWindowsProcessCreationTime: (pid: number) => host.creationTimes.get(pid) ?? null,
  readWindowsProcessIdentityTableFresh: async () => {
    host.tableScans += 1
    return []
  }
}))

describe('isSameForegroundAgent on Windows', () => {
  let platform: PropertyDescriptor | undefined
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    host.creationTimes.clear()
    host.tableScans = 0
  })
  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    // Each check opens one process; a full table scan per new watch is the cost this guards against.
    expect(host.tableScans).toBe(0)
  })

  it('accepts the agent the lookup found, whatever image hosts it', async () => {
    // Copilot runs as node.exe; its pid existed before the lookup that named it.
    host.creationTimes.set(40, 1_000)
    expect(await isSameForegroundAgent(40, { processName: 'copilot', identifiedAt: 2_000 })).toBe(
      true
    )
  })

  it('rejects a process that took the pid after the agent was identified, even with the same name', async () => {
    host.creationTimes.set(40, 3_000)
    expect(await isSameForegroundAgent(40, { processName: 'codex.exe', identifiedAt: 2_000 })).toBe(
      false
    )
  })

  it('rejects a replacement created before the lookup when the lookup recorded the agent creation time', async () => {
    // The lookup read a capture from just before the agent exited; its pid then went to an older-than-lookup process.
    const expected = { processName: 'codex.exe', identifiedAt: 2_000, creationTimeMs: 1_000 }
    host.creationTimes.set(40, 1_500)
    expect(await isSameForegroundAgent(40, expected)).toBe(false)
    host.creationTimes.set(40, 1_000)
    expect(await isSameForegroundAgent(40, expected)).toBe(true)
  })

  it('rejects when creation time is unknown', async () => {
    expect(await isSameForegroundAgent(40, { processName: 'codex.exe', identifiedAt: 2_000 })).toBe(
      false
    )
  })
})
