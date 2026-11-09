import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  setTerminalViewAttributes,
  setRepoTerminalViewAttributes,
  setTerminalViewAttributesSeedSource
} from '../terminal/view/terminal-view-attribute-store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type {
  TerminalViewAttributes,
  TerminalViewRgb
} from '../../../shared/terminal/protocol/queries/terminal-view-attributes'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

function viewAttributes(
  foreground: TerminalViewRgb,
  background: TerminalViewRgb
): TerminalViewAttributes {
  return {
    foreground,
    background,
    cursor: [0xff, 0xff, 0xff],
    ansi: Array.from({ length: 256 }, (): TerminalViewRgb => [0, 0, 0]),
    colorSchemeMode: 'dark',
    cursorStyle: 'block',
    cursorBlink: false
  }
}

describe('OrcaRuntimeService project terminal themes', () => {
  it("passes a themed project's seeded colours to a background spawn before any renderer publish", async () => {
    // App start: persisted repos already name the project's theme, and an agent TUI queries
    // OSC 10/11 once, at start, so the spawn must carry the project colours now.
    const global = viewAttributes([0xff, 0xff, 0xff], [0x28, 0x2c, 0x34])
    setTerminalViewAttributes(global)
    const repoId = getRepoIdFromWorktreeId(TEST_WORKTREE_ID)
    const solarized = { foreground: '#839496', background: '#002b36' }
    setTerminalViewAttributesSeedSource(() => ({
      global,
      byHostId: { local: { [repoId]: viewAttributes([0x83, 0x94, 0x96], [0x00, 0x2b, 0x36]) } }
    }))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-seeded-colors' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'codex' })
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ terminalColorQueryReplies: solarized })
      )
    } finally {
      setTerminalViewAttributesSeedSource(null)
    }
  })

  it("passes the project's themed view colors to background agent spawns", async () => {
    setTerminalViewAttributes(viewAttributes([0xff, 0xff, 0xff], [0x28, 0x2c, 0x34]))
    setRepoTerminalViewAttributes({
      byHostId: {
        local: {
          [getRepoIdFromWorktreeId(TEST_WORKTREE_ID)]: viewAttributes(
            [0x83, 0x94, 0x96],
            [0x00, 0x2b, 0x36]
          )
        }
      }
    })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg-themed' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'codex' })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalColorQueryReplies: { foreground: '#839496', background: '#002b36' }
      })
    )
  })
})
