import { describe, expect, it, vi } from 'vitest'
import { waitForPipelineTerminalOutput } from './runtime-terminal-output'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'

describe('waitForPipelineTerminalOutput', () => {
  it('keeps waiting after early idle until the expected marker is visible', async () => {
    const readTerminal = vi
      .fn()
      .mockResolvedValueOnce({ tail: ['OpenAI Codex startup text'] })
      .mockResolvedValueOnce({ tail: ['OpenAI Codex startup text'] })
      .mockResolvedValueOnce({
        tail: [
          'OpenAI Codex startup text',
          '<plan>{"issues":[{"id":"manual-1","title":"Smoke","branch":"pipeline/manual-1"}]}</plan>'
        ]
      })

    const earlyIdle: RuntimeTerminalWait = {
      handle: 'term_1',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }
    const waitForTerminal = vi.fn().mockResolvedValue(earlyIdle)

    const result = await waitForPipelineTerminalOutput({
      handle: 'term_1',
      expectedText: '</plan>',
      readTerminal,
      waitForTerminal,
      timeoutMs: 1_000,
      pollIntervalMs: 1
    })

    expect(result.stdout).toContain('manual-1')
    expect(readTerminal).toHaveBeenCalledTimes(3)
  })

  it('fails clearly when the terminal exits before the expected marker', async () => {
    const readTerminal = vi.fn().mockResolvedValue({ tail: ['OpenAI Codex startup text'] })
    const exited: RuntimeTerminalWait = {
      handle: 'term_1',
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 0
    }

    await expect(
      waitForPipelineTerminalOutput({
        handle: 'term_1',
        expectedText: '</plan>',
        readTerminal,
        waitForTerminal: vi.fn().mockResolvedValue(exited),
        timeoutMs: 1_000,
        pollIntervalMs: 1
      })
    ).rejects.toMatchObject({
      code: 'missing_expected_output'
    })
  })
})
