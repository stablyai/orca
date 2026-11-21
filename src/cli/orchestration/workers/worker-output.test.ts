import { describe, expect, it } from 'vitest'
import { formatWorkerStart } from './worker-output'

describe('worker-start role configuration', () => {
  it('shows the selected role and launch configuration without inventing unknown defaults', () => {
    expect(
      formatWorkerStart({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'ready',
        launch: {
          role: 'review',
          effective: {
            agent: 'codex',
            model: 'current-model',
            effort: null,
            fastMode: true,
            serviceTier: 'priority'
          }
        }
      })
    ).toContain(
      'Role: review\nLaunch configuration: agent=codex model=current-model effort=agent-default Fast=on serviceTier=priority'
    )
    expect(
      formatWorkerStart({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'outcome_unknown',
        launch: { role: 'review', effective: null }
      })
    ).toContain('Launch configuration: unverified')
  })
})
