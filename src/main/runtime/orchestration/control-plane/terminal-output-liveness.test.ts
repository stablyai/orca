import { describe, expect, it } from 'vitest'
import { classifyDispatchLiveness } from './dispatch-liveness'
import { toLivenessEvidence, type DispatchLivenessSignals } from './dispatch-liveness-evidence'
import type { DispatchContextRow } from '../types'

/** TERMINAL_OUTPUT_LIVENESS — activity was read from the agent-hook stamp
 *  alone. A worker visibly producing terminal output while its agent emitted no
 *  new hook event aged out of the stall window and was reported stalled, even
 *  though Orca's own PTY stream said otherwise. Model heartbeats stay excluded:
 *  the new source is the runtime's observation of the stream.
 */
describe('TERMINAL_OUTPUT_LIVENESS', () => {
  const NOW = Date.parse('2026-08-27T18:00:00Z')
  const STALL_MS = 10 * 60 * 1000

  const dispatch = {
    id: 'ctx_1',
    run_id: 'run_1',
    task_id: 'task_1',
    status: 'dispatched',
    assignee_handle: 'term_worker',
    assignee_pane_key: 'pane:leaf',
    process_incarnation: 'pty:term_worker',
    termination_reason: null,
    dispatched_at: new Date(NOW - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  } as unknown as DispatchContextRow

  function signals(overrides: Partial<DispatchLivenessSignals>): DispatchLivenessSignals {
    return {
      dispatch,
      agentStatus: null,
      processLiveness: 'live',
      approvedWaitUntilIso: null,
      terminalOwnership: 'owned',
      lastTerminalOutputAtMs: null,
      settled: false,
      ...overrides
    }
  }

  it('is not stalled while the terminal keeps producing output with no new hook event', () => {
    const evidence = toLivenessEvidence(
      signals({
        // The hook stream went quiet well beyond the stall window...
        agentStatus: {
          state: 'working',
          toolName: undefined,
          receivedAt: NOW - STALL_MS - 60_000,
          interactivePrompt: undefined
        } as DispatchLivenessSignals['agentStatus'],
        // ...but Orca watched the PTY produce output ten seconds ago.
        lastTerminalOutputAtMs: NOW - 10_000
      })
    )
    expect(classifyDispatchLiveness(evidence, NOW)).toMatchObject({
      verdict: 'live',
      activity: 'working'
    })
  })

  it('becomes stalled once no authoritative source has reported activity past the threshold', () => {
    const evidence = toLivenessEvidence(
      signals({
        agentStatus: {
          state: 'working',
          toolName: undefined,
          receivedAt: NOW - STALL_MS - 60_000,
          interactivePrompt: undefined
        } as DispatchLivenessSignals['agentStatus'],
        lastTerminalOutputAtMs: NOW - STALL_MS - 30_000
      })
    )
    expect(classifyDispatchLiveness(evidence, NOW)).toMatchObject({ activity: 'stalled' })
  })

  it('takes the newest of the authoritative sources, whichever one it is', () => {
    const hookNewer = toLivenessEvidence(
      signals({
        agentStatus: {
          state: 'working',
          toolName: undefined,
          receivedAt: NOW - 5_000,
          interactivePrompt: undefined
        } as DispatchLivenessSignals['agentStatus'],
        lastTerminalOutputAtMs: NOW - 600_000
      })
    )
    expect(Date.parse(hookNewer.lastActivityAt as string)).toBe(NOW - 5_000)
    const outputNewer = toLivenessEvidence(
      signals({ agentStatus: null, lastTerminalOutputAtMs: NOW - 5_000 })
    )
    expect(Date.parse(outputNewer.lastActivityAt as string)).toBe(NOW - 5_000)
  })

  it('falls back to the dispatch stamp when the runtime observed nothing at all', () => {
    const evidence = toLivenessEvidence(signals({}))
    expect(evidence.lastActivityAt).not.toBeNull()
    expect(classifyDispatchLiveness(evidence, NOW).activity).toBe('stalled')
  })
})
