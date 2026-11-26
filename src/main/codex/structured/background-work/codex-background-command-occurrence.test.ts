import { describe, expect, it } from 'vitest'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { liveEvidenceOccurrence } from '../../../native-chat/agent-session-wire/command-details/structured-command-occurrence'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'

const PRIMARY = 'thread-primary'

function started(item: Record<string, unknown>, method = 'item/started') {
  return {
    method,
    threadId: PRIMARY,
    params: {
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'call-1',
        status: 'inProgress',
        source: 'unifiedExecStartup',
        processId: 'proc-1',
        command: `/bin/bash -lc 'pnpm test --run'`,
        ...item
      }
    }
  }
}

function liveEdges(tracker: CodexBackgroundTaskTracker): AgentChildWorkEvidence[] {
  return tracker.drainChildWorkEvidence(1).filter((edge) => edge.type === 'live')
}

function occurrenceOf(edge: AgentChildWorkEvidence | undefined) {
  return edge?.type === 'live' ? liveEvidenceOccurrence(edge.child) : null
}

describe('Codex command occurrence capture', () => {
  it('captures the unwrapped command from a proven live startup and marks every restatement', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(started({}))
    const first = occurrenceOf(liveEdges(tracker)[0])
    expect(first?.display).toBe('pnpm test --run')
    // The turn ends and the command is restated as background work with the same occurrence.
    tracker.observe({
      method: 'turn/completed',
      threadId: PRIMARY,
      params: { turn: { id: 'turn-1', status: 'completed' } }
    })
    const restated = liveEdges(tracker)
    expect(restated.length).toBeGreaterThan(0)
    expect(occurrenceOf(restated.at(-1))).toBe(first)
  })

  it('records no text for placeholders, interaction, foreign sources or a missing process', () => {
    for (const item of [
      { processId: undefined },
      { source: 'agent' },
      { status: 'completed' },
      { command: 42 }
    ]) {
      const tracker = new CodexBackgroundTaskTracker(PRIMARY)
      tracker.observe(started(item))
      const occurrence = occurrenceOf(liveEdges(tracker)[0])
      expect(occurrence?.display ?? null).toBeNull()
    }
  })

  it('a duplicate start keeps the first occurrence and its original text', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(started({ command: 'echo A' }))
    const first = occurrenceOf(liveEdges(tracker)[0])
    tracker.observe(started({ command: 'echo B' }))
    expect(liveEdges(tracker)).toHaveLength(0)
    expect(first?.display).toBe('echo A')
  })

  it('ending the command ends its occurrence, so queued evidence can no longer bind', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(started({}))
    const queued = tracker.drainChildWorkEvidence(1)
    tracker.observe(started({ status: 'completed' }, 'item/completed'))
    expect(occurrenceOf(queued.find((edge) => edge.type === 'live'))).toBeNull()
  })
})
