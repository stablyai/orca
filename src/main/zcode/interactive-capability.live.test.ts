import { existsSync } from 'node:fs'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  readZCodeInteractiveCapability,
  _resetZCodeInteractiveCapabilityForTests
} from './interactive-capability'

// Two real ZCode builds on this machine: the desktop app's bundled runtime (no TUI) and a
// CLI built from zai-org/ZCode (has TUI). Skipped anywhere they are absent.
const WITHOUT_TUI = '/tmp/zcode-bin-notui/zcode'
const WITH_TUI = '/tmp/zcode-bin-tui/zcode'
const bothPresent = existsSync(WITHOUT_TUI) && existsSync(WITH_TUI)
const describeLive = bothPresent ? describe : describe.skip

beforeEach(() => _resetZCodeInteractiveCapabilityForTests())

describeLive('readZCodeInteractiveCapability against real ZCode builds', () => {
  it("reports missing-tui for the desktop app's bundled runtime", async () => {
    await expect(readZCodeInteractiveCapability(WITHOUT_TUI)).resolves.toBe('missing-tui')
  }, 30_000)

  it('reports interactive for a CLI built from source', async () => {
    await expect(readZCodeInteractiveCapability(WITH_TUI)).resolves.toBe('interactive')
  }, 30_000)

  it('fails open when the command does not exist', async () => {
    await expect(readZCodeInteractiveCapability('/tmp/definitely-not-zcode')).resolves.toBe(
      'unknown'
    )
  }, 30_000)
})
