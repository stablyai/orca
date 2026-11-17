import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentStartupBlockedMessage } from './agent-startup-blocked-message'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

function fixture(name: string): { recording: string; cols: number; rows: number } {
  const url = (ext: string) => new URL(`../../__fixtures__/${name}.${ext}`, import.meta.url)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(url('meta.json'), 'utf8'))
  return { recording: readFileSync(url('txt'), 'utf8'), cols: meta.cols, rows: meta.rows }
}

describe('agentStartupBlockedMessage', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    vi.useRealTimers()
  })

  async function replay(name: string) {
    vi.useFakeTimers()
    const { recording, cols, rows } = fixture(name)
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: '2.1.316',
      launchAgent: 'claude',
      size: { cols, rows },
      data: ''
    })
    cleanups.push(async () => {
      await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, recording, 1)
    await vi.advanceTimersByTimeAsync(100)
    return { runtime, handle }
  }

  it("names Claude's captured Bypass Permissions warning and the setting, keeping the parsed reason first", async () => {
    const { runtime, handle } = await replay('claude-2-1-316-startup-bypass-permissions')
    await expect(
      agentStartupBlockedMessage(runtime, handle, 'agent-startup-menu-prompt')
    ).resolves.toBe(
      'Agent startup blocked: agent-startup-menu-prompt. ' +
        'Claude is asking to confirm Bypass Permissions mode. Accept it once in that terminal, ' +
        "or change Claude's permission in this host's Settings > Agents > Permissions."
    )
  })

  it('leaves other startup menus as the bare reason', async () => {
    const { runtime, handle } = await replay('claude-2-1-316-startup-mcp-server')
    await expect(
      agentStartupBlockedMessage(runtime, handle, 'agent-startup-menu-prompt')
    ).resolves.toBe('Agent startup blocked: agent-startup-menu-prompt')
  })

  it('does not read the screen for other reasons and keeps the legacy alias', async () => {
    const runtime = { readTerminal: vi.fn() }
    await expect(
      agentStartupBlockedMessage(runtime, 'term_1', 'codex-interactive-prompt')
    ).resolves.toBe('Agent startup blocked: codex-interactive-prompt (agent-interactive-prompt)')
    expect(runtime.readTerminal).not.toHaveBeenCalled()
  })

  it('falls back to the bare reason when the pane is gone', async () => {
    const runtime = { readTerminal: vi.fn().mockRejectedValue(new Error('terminal_not_found')) }
    await expect(
      agentStartupBlockedMessage(runtime, 'term_1', 'agent-startup-menu-prompt')
    ).resolves.toBe('Agent startup blocked: agent-startup-menu-prompt')
  })
})
