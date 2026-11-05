import { describe, expect, it } from 'vitest'
import { formatMessageBanner, formatMessagePointer, isMessagePointerText } from './formatter'
import type { MessageRow } from './types'

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg_test1',
    run_id: 'run_test',
    from_handle: 'term_abc123',
    to_handle: 'term_coord',
    subject: 'Auth API implementation complete',
    body: 'All endpoints implemented. Tests passing.',
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: null,
    read: 0,
    sequence: 1,
    created_at: '2026-01-01T00:00:00Z',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  }
}

describe('formatMessageBanner', () => {
  it('formats a normal priority message without a priority tag', () => {
    const banner = formatMessageBanner(makeMessage())
    expect(banner).toContain('From: TERM_ABC123 (term_abc123)')
    expect(banner).toContain('(worker_done)')
    expect(banner).not.toContain('[URGENT]')
    expect(banner).not.toContain('[HIGH]')
  })

  it('includes reply hint with message ID', () => {
    const banner = formatMessageBanner(makeMessage({ id: 'msg_xyz789' }))
    expect(banner).toContain(
      '[Reply: orca orchestration reply --id msg_xyz789 --from term_coord --body "..."]'
    )
  })

  it('lets the CLI resolve the live sender for Run and Dispatch addresses', () => {
    for (const to_handle of ['run:run_test', 'dispatch:dispatch_test']) {
      const banner = formatMessageBanner(makeMessage({ to_handle }))
      expect(banner).toContain('[Reply: orca orchestration reply --id msg_test1 --body "..."]')
      expect(banner).not.toContain(`--from ${to_handle}`)
    }
  })

  it('marks legacy messages read-only without reply or acknowledgment affordances', () => {
    const banner = formatMessageBanner(
      makeMessage({ id: 'msg_legacy', run_id: 'run_legacy_local' })
    )

    expect(banner).toContain('[LEGACY READ-ONLY]')
    expect(banner).toContain('[Inspection only: reply and acknowledgment are unavailable.]')
    expect(banner).not.toContain('[Reply:')
    expect(banner).not.toContain('orchestration reply')
  })

  it('renders only attested actions for legacy compatibility authority', () => {
    const banner = formatMessageBanner(makeMessage({ id: 'msg_legacy' }), {
      authority: 'legacy_compatibility',
      supportedActionHints: [
        'orca orchestration reply --id msg_legacy --from term_coord --body "..."'
      ]
    })

    expect(banner).toContain('[LEGACY COMPATIBILITY]')
    expect(banner).toContain(
      '[Supported action: orca orchestration reply --id msg_legacy --from term_coord --body "..."]'
    )
    expect(banner).not.toContain('[Reply:')
    expect(banner).not.toContain('acknowledgment')
  })

  it('warns that a bounded legacy recovery replay may already have been seen', () => {
    const banner = formatMessageBanner(makeMessage(), {
      authority: 'legacy_recovery_replay',
      supportedActionHints: ['orca orchestration check --ack delivery_legacy']
    })

    expect(banner).toContain('[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]')
    expect(banner).toContain('bounded recovery replay may already have been seen')
    expect(banner).toContain('[Supported action: orca orchestration check --ack delivery_legacy]')
    expect(banner).not.toContain('[Reply:')
  })

  it('does not infer live compatibility from legacy database provenance', () => {
    const banner = formatMessageBanner(makeMessage({ run_id: 'run_legacy_local' }), {
      supportedActionHints: ['orca orchestration check --ack delivery_legacy']
    })

    expect(banner).toContain('[LEGACY READ-ONLY]')
    expect(banner).not.toContain('Supported action:')
    expect(banner).not.toContain('check --ack')
  })

  it('keeps adopted legacy and audit messages read-only without runtime authority', () => {
    for (const deliveryContract of ['legacy_direct', 'audit_only'] as const) {
      const banner = formatMessageBanner(
        makeMessage({ run_id: 'run_adopted', delivery_contract: deliveryContract })
      )

      expect(banner).toContain('[LEGACY READ-ONLY]')
      expect(banner).not.toContain('[Reply:')
    }
  })
})

describe('isMessagePointerText', () => {
  it('recognizes every pointer Orca types, however the composer wraps it', () => {
    const pointers = [
      formatMessagePointer(1, 'run:run_123456789abc', 'orca'),
      formatMessagePointer(3, 'dispatch:ctx_1', 'orca-dev'),
      formatMessagePointer(2, 'run:run_1', 'orca', 'delivery_123456789abc')
    ]
    for (const pointer of pointers) {
      expect(isMessagePointerText(pointer)).toBe(true)
      expect(isMessagePointerText(pointer.trim().replace(/(.{18})/g, '$1\n  '))).toBe(true)
    }
  })

  it.each([
    'You have 1 orchestration message. Why?',
    'You have 1 orchestration message. Run `foo` and then `orca orchestration check`.',
    'You have 1 new orchestration message after delivery d_1, which you have not acknowledged. Please draft a reply for the new mail.'
  ])('treats user text that only resembles a pointer as a draft: %s', (text) => {
    expect(isMessagePointerText(text)).toBe(false)
  })
})
