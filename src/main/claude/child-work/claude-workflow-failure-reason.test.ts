import { describe, expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { createClaudeJournalTranslator } from '../structured/journal/claude-structured-journal-translation'

const workflowCall = {
  type: 'assistant',
  uuid: 'a1',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Workflow', input: { name: 'review' } }]
  }
}
const workflowStarted = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'wf-1',
  tool_use_id: 'toolu_1',
  description: 'Review changed files',
  task_type: 'local_workflow',
  session_id: 'session-1'
}
const workflowProgress = {
  type: 'system',
  subtype: 'task_progress',
  task_id: 'wf-1',
  workflow_progress: [
    { type: 'workflow_phase', index: 1, title: 'Review' },
    { type: 'workflow_phase', index: 2, title: 'Verify' },
    { type: 'workflow_agent', index: 1, label: 'a', state: 'done', phaseIndex: 1 },
    { type: 'workflow_agent', index: 2, label: 'b', state: 'progress', phaseIndex: 2 }
  ],
  session_id: 'session-1'
}
const phaseLine = 'Phase 2/2 · Verify · 0/1 agents done'
const failedWithoutReason = {
  type: 'system',
  subtype: 'task_updated',
  task_id: 'wf-1',
  patch: { status: 'failed' },
  session_id: 'session-1'
}

function decode(frames: Record<string, unknown>[]) {
  const journal = createClaudeJournalTranslator({
    sink: { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
  })
  const decoder = new ClaudeChildWorkDecoder(journal.taskInvocations)
  return frames.flatMap((message) => {
    decoder.observe(message)
    journal.handle({ type: 'message', sessionId: 'orca', observedAt: 1_000, message })
    return decoder.drain(1_000)
  })
}

/** The message the dock reads for the row: admission keeps the last live message unless the ending
 *  reports its own (agent-status-child-work-admission-core.ts `said.lastMessage ?? run?.lastMessage`). */
function failureReason(frames: Record<string, unknown>[]): string | undefined {
  let message: string | undefined
  for (const edge of decode(frames)) {
    if (edge.type === 'live' && edge.child.lastMessage !== undefined) {
      message = edge.child.lastMessage
    } else if (edge.type === 'ended' && edge.lastMessage !== undefined) {
      message = edge.lastMessage
    }
  }
  return message
}

describe('a failed workflow without an error of its own', () => {
  it('shows the phase line while it runs', () => {
    expect(failureReason([workflowCall, workflowStarted, workflowProgress])).toBe(phaseLine)
  })

  it('reports its last summary as the reason, not the phase line', () => {
    expect(
      failureReason([
        workflowCall,
        workflowStarted,
        { ...workflowProgress, summary: 'Checked 3 files' },
        failedWithoutReason
      ])
    ).toBe('Checked 3 files')
  })

  it('reports its description when progress never carried a summary', () => {
    expect(
      failureReason([workflowCall, workflowStarted, workflowProgress, failedWithoutReason])
    ).toBe('Review changed files')
  })

  it('still reports the error the failure carries', () => {
    expect(
      failureReason([
        workflowCall,
        workflowStarted,
        workflowProgress,
        { ...failedWithoutReason, patch: { status: 'failed', error: 'agent crashed' } }
      ])
    ).toBe('agent crashed')
  })

  it('keeps the phase line when a later frame carries only a summary', () => {
    expect(
      failureReason([
        workflowCall,
        workflowStarted,
        workflowProgress,
        { type: 'system', subtype: 'task_progress', task_id: 'wf-1', summary: 'Checked 3 files' }
      ])
    ).toBe(phaseLine)
  })

  it('reports the latest summary even when a later frame has no phase line', () => {
    expect(
      failureReason([
        workflowCall,
        workflowStarted,
        { ...workflowProgress, summary: 'first' },
        { type: 'system', subtype: 'task_progress', task_id: 'wf-1', summary: 'second' },
        failedWithoutReason
      ])
    ).toBe('second')
  })

  it('leaves a workflow that never reported phases to its own summary behaviour', () => {
    expect(
      failureReason([
        workflowCall,
        workflowStarted,
        { type: 'system', subtype: 'task_progress', task_id: 'wf-1', summary: 'Working' },
        failedWithoutReason
      ])
    ).toBe('Working')
  })
})
