import { describe, expect, it } from 'vitest'
import { formatAgentFieldsText } from '../agent-view'
import { WORKER_SHOW_VIEW } from './worker-agent-views'
import type { WorkerShowResult } from './worker-view-results'

// worker-show for a settled predecessor whose terminal row its follow-up now owns and runs.
const handedOn: WorkerShowResult = {
  dispatch: { id: 'ctx_pred', taskId: 'task_1', status: 'completed', followUpOf: null },
  worker: { state: 'succeeded', stage: 'process_exited', agentTerminalHandle: 'term_shared' },
  terminalResource: { releaseState: 'not_requested', terminalHandle: 'term_shared' },
  handedOnTo: 'ctx_next'
}

describe('default worker-show view of a handed-on predecessor', () => {
  it('names the follow-up and never shows its terminal release state as this worker’s', () => {
    const fields = WORKER_SHOW_VIEW.fields(handedOn)
    expect(fields.handedOnTo).toBe('ctx_next')
    expect(fields.terminalState).toBeUndefined()
    expect(fields.terminal).toBeUndefined()
    const text = formatAgentFieldsText(fields)
    expect(text).toContain('handedOnTo=ctx_next')
    expect(text).not.toContain('not_requested')
  })
})
