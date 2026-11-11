import { describe, expect, it } from 'vitest'
import {
  taskLinearStatusSchema,
  taskPreflightSchema,
  taskUiStateSchema
} from './task-runtime-reply-schema'

describe('the persisted UI state', () => {
  it.each([null, undefined, 'ok', 7, [], true])(
    'answers undefined for %j, so the other hydration legs survive an unreadable ui reply',
    (payload) => {
      const parsed = taskUiStateSchema.safeParse(payload)
      expect(parsed.success).toBe(true)
      expect(parsed.success ? parsed.data : 'unparsed').toBeUndefined()
    }
  )
})

describe('the two advisory probes', () => {
  // Advisory acceptance still decodes absent/null results; total readers must retain hydration defaults instead of throwing.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a bare string', 'preflight'],
    ['an array', []]
  ])('reads a %s payload as "nothing advertised" rather than refusing it', (_label, reply) => {
    const preflight = taskPreflightSchema.safeParse(reply)
    expect(preflight.success).toBe(true)
    expect(preflight.success && preflight.data.glab?.installed).toBeUndefined()
    const linear = taskLinearStatusSchema.safeParse(reply)
    expect(linear.success).toBe(true)
    expect(linear.success && linear.data.connected).toBeUndefined()
  })
})
