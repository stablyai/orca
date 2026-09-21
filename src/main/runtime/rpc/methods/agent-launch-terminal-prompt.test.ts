/**
 * What the host may claim about a prompt it wrote into somebody's PTY.
 *
 * The receipt has no "maybe" arm, so each case below has to resolve to delivered or not, and the
 * two failure shapes pull in opposite directions: a composer that never opened means the text is
 * definitely absent, while a stalled submission means it is definitely present and merely
 * unobserved. Getting the second one wrong duplicates a turn instead of dropping one.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'
import { AGENT_PROMPT_STALLED_ERROR } from '../../agent-prompt-submission-verification'

type SendResult = { handle: string; accepted: boolean; bytesWritten: number }
type SendFn = (
  handle: string,
  text: string,
  options: Record<string, unknown>
) => Promise<SendResult>

function runtimeStub(overrides: { wait?: unknown; send?: SendFn }) {
  const waitForTerminal = vi.fn(async () => overrides.wait ?? { satisfied: true, status: 'idle' })
  const sendTerminalAgentPrompt = vi.fn<SendFn>(
    overrides.send ?? (async () => ({ handle: 'term_1', accepted: true, bytesWritten: 12 }))
  )
  return {
    waitForTerminal,
    sendTerminalAgentPrompt,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deliverer reaches exactly these two runtime methods; anything else would throw rather than read a wrong value.
    runtime: { waitForTerminal, sendTerminalAgentPrompt } as unknown as Parameters<
      typeof deliverTerminalAgentLaunchPrompt
    >[0]['runtime']
  }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('writing a launch prompt into a terminal agent', () => {
  it('waits for the composer before writing, and reports the write', async () => {
    const stub = runtimeStub({})
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    const [handle, text, options] = stub.sendTerminalAgentPrompt.mock.calls[0]!
    expect(handle).toBe('term_1')
    expect(text).toBe('do the thing')
    // Paired: without both, an unobserved first turn is raised instead of settled, and a slow
    // agent would be reported as undelivered while its prompt sat in the pane.
    expect(options.acceptQueued).toBe(true)
    expect(options.requestId).toEqual(expect.any(String))
  })

  it('does not write when the composer never opened', async () => {
    const stub = runtimeStub({ wait: { satisfied: false, status: 'blocked' } })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      text: 'do the thing'
    })

    // A trust or update prompt is on screen; the text would answer whatever it asked.
    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('reports a stalled submission as delivered, because the stall is raised after the write', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error(AGENT_PROMPT_STALLED_ERROR)
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      text: 'do the thing'
    })

    // Under-claiming here would resend the whole prompt into an agent already working on it.
    expect(delivered).toBe(true)
  })

  it('under-claims when the write itself failed', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error('terminal_not_writable')
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
  })

  it('does not fail the launch when the readiness wait throws', async () => {
    const stub = runtimeStub({})
    stub.waitForTerminal.mockRejectedValueOnce(new Error('terminal_handle_stale'))
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      text: 'do the thing'
    })

    // The agent is running; a delivery failure must never become a launch failure.
    expect(delivered).toBe(false)
  })

  it('writes nothing for blank text', async () => {
    const stub = runtimeStub({})
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        text: '   '
      })
    ).toBe(false)
    expect(stub.waitForTerminal).not.toHaveBeenCalled()
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
