import { describe, expect, it } from 'vitest'
import { createAntigravitySessionResumeState } from './session-scanner-antigravity-parser'

const file = {
  path: '/tmp/brain/usage-session/.system_generated/logs/transcript.jsonl',
  mtimeMs: 1,
  modifiedAt: '2026-11-16T00:00:00Z'
}

function record(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    step_index: 1,
    input_tokens: 100,
    cache_read_tokens: 900,
    output_tokens: 20,
    thinking_tokens: 10,
    ...extra
  })
}

describe('Antigravity measured usage', () => {
  it('counts separate fresh/cache/output buckets even without message text', async () => {
    const state = createAntigravitySessionResumeState(file)
    state.consumeLine(record({ model: 'gemini-4-hydrogen-high' }))
    const session = await state.finalize('linux')
    expect(session?.totalTokens).toBe(1020)
    expect(session?.model).toBe('gemini-4-hydrogen-high')
  })

  it('leaves old transcripts unpriced and rejects tools and invalid counters', async () => {
    const state = createAntigravitySessionResumeState(file)
    state.consumeLine(record({ input_tokens: undefined }))
    state.consumeLine(record({ type: 'RUN_COMMAND' }))
    state.consumeLine(record({ input_tokens: -1 }))
    state.consumeLine(record({ output_tokens: 1.5 }))
    state.consumeLine(record({ status: 'RUNNING' }))
    state.consumeLine(record({ step_index: undefined }))
    const session = await state.finalize('linux')
    expect(session?.totalTokens).toBe(0)
    expect(session?.model).toBeNull()
  })

  it('replaces repeated steps and isolates incremental parse clones', async () => {
    const state = createAntigravitySessionResumeState(file)
    state.consumeLine(record())
    state.consumeLine(record())
    const clone = state.clone()
    clone.consumeLine(record({ output_tokens: 30 }))
    state.consumeLine(record({ output_tokens: 25 }))
    state.consumeLine(record({ step_index: 2, input_tokens: 0, cache_read_tokens: 0 }))
    expect((await state.finalize('linux'))?.totalTokens).toBe(1045)
    expect((await clone.finalize('linux'))?.totalTokens).toBe(1030)
    expect((await state.finalize('linux'))?.model).toBeNull()
  })
})
