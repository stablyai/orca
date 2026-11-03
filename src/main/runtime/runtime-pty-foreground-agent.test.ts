import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

describe('RuntimePtyForegroundAgent.identifyUnowned', () => {
  afterEach(() => vi.useRealTimers())

  function setup() {
    const reads: ((name: string) => void)[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: identifyForeground only calls getForegroundProcess
    const controller = {
      getForegroundProcess: () => new Promise<string>((resolve) => reads.push(resolve))
    } as unknown as RuntimePtyController
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: identifyUnowned reads only connected and the agent fields
    const pty = { connected: true } as RuntimePtyWorktreeRecord
    const agent = new RuntimePtyForegroundAgent({
      getController: () => controller,
      getPty: () => pty,
      touchSnapshot: () => {},
      finishDelayedSnapshot: () => {}
    })
    return { agent, reads, pty }
  }

  // Why: a read that always outlasts the timeout would otherwise time out on every retry.
  it('hands a read that settled after its timeout to the next call', async () => {
    vi.useFakeTimers()
    const { agent, reads } = setup()
    const first = agent.identifyUnowned('pty-1', () => true)
    await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS)
    await expect(first).resolves.toBeUndefined()
    reads[0]!('claude')
    await vi.advanceTimersByTimeAsync(0)

    await expect(agent.identifyUnowned('pty-1', () => true)).resolves.toBe('claude')
    expect(reads).toHaveLength(1)
  })

  it('does not hand a late answer past the candidate and launch guards', async () => {
    vi.useFakeTimers()
    const { agent, reads, pty } = setup()
    void agent.identifyUnowned('pty-1', () => true)
    await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS)
    reads[0]!('claude')
    await vi.advanceTimersByTimeAsync(0)
    expect(agent.identifyUnowned('pty-1', () => false)).toBeNull()
    pty.launchAgent = 'codex'
    expect(agent.identifyUnowned('pty-1', () => true)).toBeNull()
  })

  it('rereads once a kept late answer is older than a retry would be', async () => {
    vi.useFakeTimers()
    const { agent, reads } = setup()
    void agent.identifyUnowned('pty-1', () => true)
    await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS)
    reads[0]!('claude')
    await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS + 1)
    void agent.identifyUnowned('pty-1', () => true)
    expect(reads).toHaveLength(2)
  })
})
