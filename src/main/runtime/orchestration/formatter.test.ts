import { describe, expect, it } from 'vitest'
import { formatMessageBanner, formatMessagesForInjection } from './formatter'
import type { MessageRow } from './types'

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg_test1',
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

  it('includes [HIGH] tag for high priority', () => {
    const banner = formatMessageBanner(makeMessage({ priority: 'high' }))
    expect(banner).toContain('[HIGH]')
  })

  it('includes [URGENT] tag for urgent priority', () => {
    const banner = formatMessageBanner(makeMessage({ priority: 'urgent' }))
    expect(banner).toContain('[URGENT]')
  })

  it('includes body after subject', () => {
    const banner = formatMessageBanner(makeMessage({ body: 'Some details here' }))
    const lines = banner.split('\n')
    const subjectIdx = lines.findIndex((l) => l.startsWith('Subject:'))
    const bodyIdx = lines.indexOf('Some details here')
    expect(subjectIdx).toBeGreaterThanOrEqual(0)
    expect(bodyIdx).toBeGreaterThan(subjectIdx)
  })

  it('omits body line when body is empty', () => {
    const banner = formatMessageBanner(makeMessage({ body: '' }))
    const lines = banner.split('\n')
    // Subject line should be immediately followed by Reply hint (no empty body line)
    const subjectIdx = lines.findIndex((l) => l.startsWith('Subject:'))
    expect(lines[subjectIdx + 1]).toMatch(/^\[Reply:/)
  })

  it('includes payload when present', () => {
    const payload = '{"taskId":"task_1","exitCode":0}'
    const banner = formatMessageBanner(makeMessage({ payload }))
    expect(banner).toContain(`[Payload: ${payload}]`)
  })

  it('omits payload line when payload is null', () => {
    const banner = formatMessageBanner(makeMessage({ payload: null }))
    expect(banner).not.toContain('[Payload:')
  })

  it('includes reply hint with message ID', () => {
    const banner = formatMessageBanner(makeMessage({ id: 'msg_xyz789' }))
    expect(banner).toContain('[Reply: orca orchestration reply --id msg_xyz789 --body "..."]')
  })

  it('ends with a separator line', () => {
    const banner = formatMessageBanner(makeMessage())
    const lines = banner.split('\n')
    expect(lines.at(-1)).toMatch(/^─+$/)
  })
})

describe('formatMessagesForInjection', () => {
  it('returns empty string for empty array', () => {
    expect(formatMessagesForInjection([])).toBe('')
  })

  it('wraps multiple banners with orchestration messages header', () => {
    const messages = [makeMessage({ id: 'msg_1' }), makeMessage({ id: 'msg_2' })]
    const result = formatMessagesForInjection(messages)
    expect(result).toContain('--- Orchestration Messages (2) ---')
    expect(result).toContain('msg_1')
    expect(result).toContain('msg_2')
    expect(result).toMatch(/\n---\n$/)
  })

  it('separates multiple banners with blank lines', () => {
    const messages = [makeMessage({ id: 'msg_a' }), makeMessage({ id: 'msg_b' })]
    const result = formatMessagesForInjection(messages)
    // Two banners should be separated by \n\n
    const bannerA = formatMessageBanner(messages[0])
    const bannerB = formatMessageBanner(messages[1])
    expect(result).toContain(`${bannerA}\n\n${bannerB}`)
  })
})
