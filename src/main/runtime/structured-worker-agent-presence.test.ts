/**
 * `isTerminalRunningAgent` for a worker that IS a structured agent session.
 *
 * This seam had no test at all: nothing in the repo referenced `isLiveStructuredAgent`, so the
 * early return could be deleted and every suite stayed green. `dispatch --to <worker> --inject`
 * depends on it — without it `getLiveLeaf` throws, the catch returns false, and a coordinator is
 * told its worker is a bare shell (`no_agent_detected`).
 */

import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalAgentPresence } from './runtime-terminal-agent-presence'

function presence(isLiveStructuredAgent: (handle: string) => boolean) {
  const getLiveLeaf = vi.fn(() => {
    // Exactly what the runtime does for a handle with no pane, and the reason the catch below
    // used to swallow the question into `false`.
    throw new Error('terminal_handle_stale')
  })
  return {
    getLiveLeaf,
    presence: new RuntimeTerminalAgentPresence({
      isLiveStructuredAgent,
      getLivePty: () => null,
      getLiveLeaf: getLiveLeaf as never,
      getPrimaryLeaf: () => null,
      getTrackedPty: () => null,
      getTabTitle: () => null,
      getForegroundProcess: () => null
    })
  }
}

describe('agent presence for a structured worker', () => {
  it('reports the session as running an agent without probing a pane', async () => {
    const { presence: subject, getLiveLeaf } = presence(() => true)
    await expect(subject.isRunning('structworker_1')).resolves.toBe(true)
    // A structured session IS the agent; there is no foreground process to recognise, and the
    // leaf probe would only throw.
    expect(getLiveLeaf).not.toHaveBeenCalled()
  })

  it('still answers false for a handle that is not a live structured worker', async () => {
    const { presence: subject } = presence(() => false)
    await expect(subject.isRunning('term_gone')).resolves.toBe(false)
  })
})
