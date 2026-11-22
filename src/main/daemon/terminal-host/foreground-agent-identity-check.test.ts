import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSameForegroundAgent } from './foreground-agent-identity-check'

type Row = { pid: number; name: string; creationTimeMs?: number }
const table = vi.hoisted((): { rows: Row[] } => ({ rows: [] }))
vi.mock('../../windows/windows-process-table', () => ({
  readWindowsProcessIdentityTableFresh: async () => table.rows
}))

describe('isSameForegroundAgent on Windows', () => {
  let platform: PropertyDescriptor | undefined
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })
  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('accepts the agent the lookup found, whatever image hosts it', async () => {
    // Gemini runs as node.exe; its pid existed before the lookup that named it.
    table.rows = [{ pid: 40, name: 'node.exe', creationTimeMs: 1_000 }]
    expect(await isSameForegroundAgent(40, { processName: 'gemini', identifiedAt: 2_000 })).toBe(
      true
    )
  })

  it('rejects a process that took the pid after the agent was identified, even with the same name', async () => {
    table.rows = [{ pid: 40, name: 'codex.exe', creationTimeMs: 3_000 }]
    expect(await isSameForegroundAgent(40, { processName: 'codex.exe', identifiedAt: 2_000 })).toBe(
      false
    )
  })

  it('rejects when creation time is unknown', async () => {
    table.rows = [{ pid: 40, name: 'codex.exe' }]
    expect(await isSameForegroundAgent(40, { processName: 'codex.exe', identifiedAt: 2_000 })).toBe(
      false
    )
  })
})
