import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandEndAgentExitVerifier,
  type CommandEndRowAnchor
} from './command-end-agent-exit-verifier'
import type { ShellForegroundProof } from '../providers/shell-foreground-proof'

// The re-ask after an unread answer is bounded and owns its timer: a PTY exit must leave nothing
// scheduled, even when the PTY's rows survive it (an unconfirmed SSH exit keeps them).

afterEach(() => {
  vi.useRealTimers()
})

function verifierAnswering(proof: ShellForegroundProof) {
  const anchor: CommandEndRowAnchor = { receivedAt: 1, agentType: 'codex', providerSessionId: 's' }
  const proveShellForeground = vi.fn(async () => proof)
  const reconcileEndedProcess = vi.fn()
  const verifier = new CommandEndAgentExitVerifier({
    readLiveRowAnchors: () => new Map([['tab:pane', anchor]]),
    checkHookAgentPresence: async () => null,
    proveShellForeground,
    reconcileEndedProcess,
    now: () => performance.now()
  })
  return { verifier, proveShellForeground, reconcileEndedProcess }
}

describe('CommandEndAgentExitVerifier re-asks', () => {
  it('asks at most three times for one command end', async () => {
    vi.useFakeTimers()
    const { verifier, proveShellForeground } = verifierAnswering('unread')

    verifier.onCommandEnd('pty-1')
    await vi.runAllTimersAsync()

    expect(proveShellForeground).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a scheduled re-ask when the PTY exits, though its rows survive', async () => {
    vi.useFakeTimers()
    const { verifier, proveShellForeground } = verifierAnswering('unread')

    verifier.onCommandEnd('pty-1')
    await vi.advanceTimersByTimeAsync(0)
    verifier.onPtyExit('pty-1')
    await vi.runAllTimersAsync()

    expect(proveShellForeground).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
