import { describe, expect, it } from 'vitest'
import { withTerminalUsage } from './worker-start-terminal-usage'

// Each terminal's own spawn reply, as the runtime records it on that terminal.
const spawnUsage: Record<string, { terminalsInUse: number; maxTerminals: number }> = {
  term_local_agent: { terminalsInUse: 205, maxTerminals: 256 },
  term_local_other: { terminalsInUse: 250, maxTerminals: 256 }
}
const runtime = { getSpawnHostTerminalUsage: (handle: string) => spawnUsage[handle] }

const receipt = (agent: { id: string; action: 'created' | 'reused' }, extra = {}) => ({
  state: 'ready',
  effects: [{ kind: 'terminal', role: 'agent', ...agent }],
  ...extra
})

describe('worker-start terminal usage', () => {
  it("reports only the count the start's own new agent terminal was spawned with", () => {
    expect(
      withTerminalUsage(runtime, receipt({ id: 'term_local_agent', action: 'created' }))
    ).toMatchObject({
      terminals: expect.stringContaining('205 of 256 in use')
    })
    // An SSH host's terminal reported no count: this computer's terminals say nothing about it.
    expect(
      withTerminalUsage(runtime, receipt({ id: 'term_ssh_agent', action: 'created' }))
    ).not.toHaveProperty('terminals')
    // A reused terminal was spawned by an earlier start.
    expect(
      withTerminalUsage(runtime, receipt({ id: 'term_local_other', action: 'reused' }))
    ).not.toHaveProperty('terminals')
  })

  it('adds nothing to a start refused at the cap, whose error already names it', () => {
    const refused = receipt(
      { id: 'term_local_agent', action: 'created' },
      { state: 'failed', blockedReason: 'terminal_host_cap' }
    )
    expect(withTerminalUsage(runtime, refused)).not.toHaveProperty('terminals')
  })
})
