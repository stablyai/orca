import { describe, expect, it } from 'vitest'

import { messagePayload } from './legacy-relay-cli-args'

describe('messagePayload', () => {
  it('keeps a payload-only JSON string unchanged', () => {
    const raw = '{"model_signature":"claude"}'

    expect(messagePayload(new Map([['payload', raw]]))).toBe(raw)
  })

  it('merges structured flags into a JSON object payload and keeps other keys', () => {
    const merged = messagePayload(
      new Map<string, string | boolean>([
        ['payload', '{"model_signature":"claude","taskId":"from-payload"}'],
        ['task-id', 'task_x'],
        ['outcome', 'failed'],
        ['files-modified', 'a.ts, b.ts']
      ])
    )

    expect(JSON.parse(merged ?? '')).toEqual({
      model_signature: 'claude',
      taskId: 'task_x',
      outcome: 'failed',
      filesModified: ['a.ts', 'b.ts']
    })
  })

  it('rejects a non-object --payload combined with structured flags', () => {
    expect(() =>
      messagePayload(
        new Map<string, string | boolean>([
          ['payload', '"text"'],
          ['phase', 'ship']
        ])
      )
    ).toThrow(/JSON object/)
  })

  it('rejects an invalid --outcome even when --payload is present', () => {
    expect(() =>
      messagePayload(
        new Map<string, string | boolean>([
          ['payload', '{"model_signature":"m"}'],
          ['outcome', 'maybe']
        ])
      )
    ).toThrow(/Invalid --outcome/)
  })
})
