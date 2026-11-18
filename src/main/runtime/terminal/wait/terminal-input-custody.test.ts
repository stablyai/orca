import { describe, expect, it } from 'vitest'
import { holdTerminalInputCustody } from './terminal-input-custody'
import { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

const fields = {
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  connected: true,
  lastExitCode: null,
  lastExitCause: null
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: custody reads only identity, incarnation and liveness fields.
const target = fields as unknown as RuntimePtyWorktreeRecord

describe('holdTerminalInputCustody', () => {
  it('keeps input through window detachment and ends it when the process is replaced', async () => {
    const waiters = new RuntimeTerminalWaiterRegistry()
    const states: string[] = []
    const held = holdTerminalInputCustody(
      {
        handle: 'term_1',
        target,
        readTarget: () => target,
        waiters,
        outlivesRenderer: true
      },
      async ({ stop, assertOriginal }) => {
        waiters.rejectRendererBound('terminal_handle_stale')
        assertOriginal()
        states.push(stop.signal.aborted ? 'stopped' : 'held')
        waiters.rejectPty('pty-1', 'terminal_handle_stale')
        states.push(stop.signal.aborted ? 'stopped' : 'held')
        assertOriginal()
      }
    )
    await expect(held).rejects.toThrow('terminal_handle_stale')
    expect(states).toEqual(['held', 'stopped'])
    expect(waiters.forPty('pty-1')).toEqual([])
  })
})
