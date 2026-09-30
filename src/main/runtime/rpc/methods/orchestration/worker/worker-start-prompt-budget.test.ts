import { describe, expect, it } from 'vitest'
import { getTerminalPasteIngestMs } from '../../../../../../shared/agent-prompt-injection'
import { ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS } from '../../../../../../shared/orchestration-timing-budgets'
import {
  isWorkerStartTaskSpecTooLarge,
  ORCHESTRATION_WORKER_START_PROMPT_MAX_BYTES,
  ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES
} from '../../../../../../shared/orchestration-worker-start-prompt-budget'
import { getTerminalInputByteLength } from '../../../../../../shared/terminal-input'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'

describe('worker-start prompt budget', () => {
  it('refuses an 8 MiB Task spec whose fake-Windows ingest outlives RPC grace', async () => {
    const spec = 'x'.repeat(8 * 1024 * 1024)
    const prompt = buildDispatchPreamble({
      taskId: 'task_test',
      dispatchId: 'ctx_test',
      dispatchCapability: `dcap_${'A'.repeat(43)}`,
      taskSpec: spec,
      coordinatorHandle: 'term_coordinator',
      workerHandle: 'term_worker'
    })

    expect(getTerminalPasteIngestMs('win32', getTerminalInputByteLength(prompt))).toBeGreaterThan(
      ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
    )
    await expect(isWorkerStartTaskSpecTooLarge(spec)).resolves.toBe(true)
  })

  it('keeps a maximum legal composition under the derived full-prompt ceiling', () => {
    const prompt = buildDispatchPreamble({
      taskId: `task_${'a'.repeat(32)}`,
      dispatchId: `ctx_${'b'.repeat(32)}`,
      dispatchCapability: `dcap_${'C'.repeat(43)}`,
      taskSpec: 'x'.repeat(ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES),
      coordinatorHandle: `term_${'d'.repeat(256)}`,
      workerHandle: `term_${'e'.repeat(256)}`,
      canDispatchSubWorkers: true
    })

    expect(getTerminalInputByteLength(prompt)).toBeLessThanOrEqual(
      ORCHESTRATION_WORKER_START_PROMPT_MAX_BYTES
    )
  })
})
