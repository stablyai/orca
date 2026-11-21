import { describe, expect, it } from 'vitest'

import { getOptionalStructuredMessagePayload } from './message-payload'

describe('getOptionalStructuredMessagePayload', () => {
  it('keeps a payload-only JSON string unchanged', () => {
    const raw = '{"model_signature":"claude","taskId":"task_1"}'

    expect(getOptionalStructuredMessagePayload(new Map([['payload', raw]]))).toBe(raw)
  })

  it('builds structured flags when --payload is omitted', () => {
    expect(
      getOptionalStructuredMessagePayload(
        new Map<string, string | boolean>([
          ['task-id', 'task_x'],
          ['dispatch-id', 'ctx_x'],
          ['outcome', 'succeeded'],
          ['files-modified', 'a.ts, b.ts'],
          ['report-path', 'r.md'],
          ['phase', 'ship']
        ])
      )
    ).toBe(
      JSON.stringify({
        taskId: 'task_x',
        dispatchId: 'ctx_x',
        outcome: 'succeeded',
        filesModified: ['a.ts', 'b.ts'],
        reportPath: 'r.md',
        phase: 'ship'
      })
    )
  })

  it('merges structured flags into a JSON object payload and keeps other keys', () => {
    const merged = getOptionalStructuredMessagePayload(
      new Map<string, string | boolean>([
        ['payload', '{"model_signature":"claude","taskId":"from-payload","note":1}'],
        ['task-id', 'task_x'],
        ['outcome', 'succeeded']
      ])
    )

    expect(JSON.parse(merged ?? '')).toEqual({
      model_signature: 'claude',
      taskId: 'task_x',
      note: 1,
      outcome: 'succeeded'
    })
  })

  it('keeps a payload outcome when no --outcome flag is passed', () => {
    const merged = getOptionalStructuredMessagePayload(
      new Map<string, string | boolean>([
        ['payload', '{"outcome":"failed","model_signature":"m"}'],
        ['task-id', 'task_x']
      ])
    )

    expect(JSON.parse(merged ?? '')).toEqual({
      outcome: 'failed',
      model_signature: 'm',
      taskId: 'task_x'
    })
  })

  it('rejects a non-object --payload combined with structured flags', () => {
    expect(() =>
      getOptionalStructuredMessagePayload(
        new Map<string, string | boolean>([
          ['payload', '["nope"]'],
          ['outcome', 'succeeded']
        ])
      )
    ).toThrow(/JSON object/)
  })

  it('rejects an invalid --outcome even when --payload is present', () => {
    expect(() =>
      getOptionalStructuredMessagePayload(
        new Map<string, string | boolean>([
          ['payload', '{"model_signature":"m"}'],
          ['outcome', 'maybe']
        ])
      )
    ).toThrow(/Invalid --outcome/)
  })
})
