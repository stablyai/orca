import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from '../bind-first-pane.test-fixture'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'

describe('terminal agent presence', () => {
  it('finds an idle Claude by a fresh read when p_comm is its version directory', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-claude' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => '2.1.310',
      confirmForegroundProcess: async () => 'claude'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'worker'
    })
    // Claude answered over OSC 7501 paints no title glyph.
    runtime.onPtyData('pty-claude', '\x1b]0;Orca worker dispatch task ok\x07', 1)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })
})
