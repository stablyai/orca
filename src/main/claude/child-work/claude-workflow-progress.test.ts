import { describe, expect, it } from 'vitest'
import { claudeWorkflowProgressText } from './claude-workflow-progress'

// Row shapes match Claude Code 2.1.332's `workflow_progress` on `task_progress` frames.
describe('claudeWorkflowProgressText', () => {
  it('reports the phase with running agents and its own agent counts', () => {
    expect(
      claudeWorkflowProgressText([
        { type: 'workflow_phase', index: 1, title: 'Review' },
        { type: 'workflow_phase', index: 2, title: 'Verify' },
        { type: 'workflow_phase', index: 3, title: 'Report' },
        { type: 'workflow_agent', index: 1, label: 'a', state: 'done', phaseIndex: 1 },
        { type: 'workflow_agent', index: 2, label: 'b', state: 'done', phaseIndex: 2 },
        { type: 'workflow_agent', index: 3, label: 'c', state: 'error', phaseIndex: 2 },
        { type: 'workflow_agent', index: 4, label: 'd', state: 'progress', phaseIndex: 2 }
      ])
    ).toBe('Phase 2/3 · Verify · 1/3 agents done, 1 failed')
  })

  it('names a phase that only its agents mention', () => {
    expect(
      claudeWorkflowProgressText([
        { type: 'workflow_phase', index: 1, title: 'Scope' },
        { type: 'workflow_agent', index: 1, label: 'a', state: 'done', phaseIndex: 1 },
        {
          type: 'workflow_agent',
          index: 2,
          label: 'b',
          state: 'start',
          phaseIndex: 2,
          phaseTitle: 'Fix'
        }
      ])
    ).toBe('Phase 2/2 · Fix · 0/1 agents done')
  })

  it('counts every agent when the script declares no phases', () => {
    expect(
      claudeWorkflowProgressText([
        { type: 'workflow_agent', index: 1, label: 'a', state: 'done' },
        { type: 'workflow_agent', index: 2, label: 'b', state: 'start' }
      ])
    ).toBe('1/2 agents done')
  })

  it('leaves the previous text in place when the snapshot is absent', () => {
    expect(claudeWorkflowProgressText(undefined)).toBeUndefined()
    expect(claudeWorkflowProgressText([])).toBeUndefined()
  })
})
