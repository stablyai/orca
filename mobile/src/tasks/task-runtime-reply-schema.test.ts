import { describe, expect, it } from 'vitest'
import {
  taskLinearStatusSchema,
  taskPreferenceWriteSchema,
  taskPreflightSchema,
  taskRuntimeStatusSchema,
  taskUiStateSchema
} from './task-runtime-reply-schema'

// Pins what the hydration reads require and what they deliberately do not.

describe('the runtime status', () => {
  it('reads the recorded capability lists', () => {
    for (const capabilities of [['mobile.tasks.v1'], ['files.mutation-ownership.v1']]) {
      const parsed = taskRuntimeStatusSchema.safeParse({ capabilities })
      expect(parsed.success && parsed.data).toMatchObject({ capabilities })
    }
  })

  it('requires the container main read `.capabilities` off', () => {
    expect(taskRuntimeStatusSchema.safeParse(null).success).toBe(false)
    expect(taskRuntimeStatusSchema.safeParse('ok').success).toBe(false)
    expect(taskRuntimeStatusSchema.safeParse({}).success).toBe(true)
  })

  it('drops a non-string capability, which `includes` could never have matched', () => {
    const parsed = taskRuntimeStatusSchema.safeParse({ capabilities: ['push.v1', 7] })
    expect(parsed.success && parsed.data).toMatchObject({ capabilities: ['push.v1'] })
  })

  it('leaves worktreeCreateIdempotency untouched in all four states the probe triages', () => {
    for (const advertised of [undefined, null, 'nonsense', { dedupeTtlMs: 45_000 }]) {
      const parsed = taskRuntimeStatusSchema.safeParse({ worktreeCreateIdempotency: advertised })
      expect(parsed.success).toBe(true)
      expect(parsed.success ? parsed.data.worktreeCreateIdempotency : 'unparsed').toEqual(
        advertised
      )
    }
  })
})

describe('the persisted UI state', () => {
  it('answers the `ui` member, which is what the member reader it replaces did', () => {
    const parsed = taskUiStateSchema.safeParse({
      ui: { sortBy: 'name', trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } } }
    })
    expect(parsed.success && parsed.data).toMatchObject({
      sortBy: 'name',
      trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } }
    })
  })

  it('reads the recorded empty ui as an empty record, not as absent', () => {
    const parsed = taskUiStateSchema.safeParse({ ui: {} })
    expect(parsed.success && parsed.data).toEqual({})
  })

  it('answers undefined for a payload with no ui, where main read undefined off the object', () => {
    const parsed = taskUiStateSchema.safeParse({})
    expect(parsed.success && parsed.data).toBeUndefined()
  })

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
  it('reads the recorded preflight and linear replies', () => {
    expect(taskPreflightSchema.safeParse({ glab: { installed: false } }).success).toBe(true)
    expect(taskLinearStatusSchema.safeParse({ connected: false }).success).toBe(true)
  })

  it('requires nothing, because every consumer compares the leaf to `true`', () => {
    expect(taskPreflightSchema.safeParse({}).success).toBe(true)
    expect(taskLinearStatusSchema.safeParse({}).success).toBe(true)
  })

  it('drops a malformed glab rather than reading it as installed', () => {
    const parsed = taskPreflightSchema.safeParse({ glab: 'yes' })
    expect(parsed.success ? parsed.data.glab : 'unparsed').toBeUndefined()
  })

  it('passes a host member no mobile consumer reads straight through', () => {
    const parsed = taskPreflightSchema.safeParse({ gh: { installed: true, authenticated: true } })
    expect(parsed.success && parsed.data).toMatchObject({
      gh: { installed: true, authenticated: true }
    })
  })

  // `success-result-or-skip` accepts an envelope whose `result` is absent or null and then asks
  // the reader to decode it, so a refusal here throws out of the caller's whole hydration. Main
  // hydrated on both of these replies; the recorded settings.task-hydration and
  // settings.workspace-context partitions are what caught the difference.
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

describe('the three preference writes', () => {
  it('accept every payload, because no call site reads their body', () => {
    for (const reply of [null, undefined, 0, 'written', { ok: true }, []]) {
      expect(taskPreferenceWriteSchema.safeParse(reply).success).toBe(true)
    }
  })
})
