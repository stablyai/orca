import { describe, expect, it } from 'vitest'
import {
  terminalDraftBeginSchema,
  terminalDraftSaveSchema,
  terminalDraftSubmitSchema
} from './terminal-draft-reply-schema'

describe('terminal draft reply schemas', () => {
  it('reads a captured multi-line draft with its agent token', () => {
    const parsed = terminalDraftBeginSchema.safeParse({
      ok: true,
      supported: true,
      adapter: 'pi-editor',
      processIncarnation: 'pid:started:instance',
      epoch: 2,
      text: 'first\nsecond\nthird',
      sourceToken: 'pi:v1:instance:hash'
    })
    expect(parsed.success && parsed.data.text).toBe('first\nsecond\nthird')
  })

  it('reads the holder of a lease another device owns', () => {
    const parsed = terminalDraftBeginSchema.safeParse({
      ok: false,
      supported: true,
      reason: 'locked',
      holder: { clientId: 'phone', clientType: 'mobile' }
    })
    expect(parsed.success && parsed.data.holder).toEqual({
      clientId: 'phone',
      clientType: 'mobile'
    })
  })

  it('keeps the current terminal version on a conflict', () => {
    const parsed = terminalDraftSaveSchema.safeParse({
      ok: false,
      status: 'conflict',
      conflict: { text: 'typed on the host', sourceToken: 'pi:v1:instance:other' }
    })
    expect(parsed.success && parsed.data.conflict?.text).toBe('typed on the host')
  })

  it('represents an unknown Enter without claiming it started a turn', () => {
    const parsed = terminalDraftSubmitSchema.safeParse({
      ok: true,
      status: 'submit_unknown',
      sourceToken: 'pi:v1:instance:hash',
      reason: 'settlement_timeout'
    })
    expect(parsed.success && parsed.data.status).toBe('submit_unknown')
  })

  it('rejects an unreadable reply instead of treating it as applied', () => {
    expect(terminalDraftSaveSchema.safeParse({ status: 'applied' }).success).toBe(false)
  })
})
