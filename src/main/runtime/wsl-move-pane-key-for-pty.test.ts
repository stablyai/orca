import { describe, expect, it, vi } from 'vitest'
import { createInventoryRuntime, PTY, processRow } from './pty-inventory-lifecycle-fixture'

describe('wslMovePaneKeyForPty', () => {
  // A pane the window never reopened after a relaunch had no spawn-time key.
  it("answers a live terminal's pane from main's records, and null for an unknown one", async () => {
    const { runtime } = createInventoryRuntime(vi.fn(async () => [processRow()]))
    runtime.register()
    expect(runtime.wslMovePaneKeyForPty(PTY)).toBe(runtime.capture().paneKey)
    expect(runtime.wslMovePaneKeyForPty(PTY)).not.toBeNull()
    expect(runtime.wslMovePaneKeyForPty('unknown@@pty')).toBeNull()
  })
})
