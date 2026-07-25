import { describe, expect, it } from 'vitest'
import {
  buildAcpApprovalCard,
  buildAcpPermissionOutcome,
  isAcpGrantOption
} from './acp-permission-bridge'

const REQUEST = {
  sessionId: 'sess-1',
  toolCall: {
    toolCallId: 'tc-1',
    title: 'Run shell command',
    kind: 'execute',
    rawInput: { command: 'rm -rf build' }
  },
  options: [
    { optionId: 'rej', name: 'Reject', kind: 'reject_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' }
  ]
}

describe('buildAcpApprovalCard', () => {
  it('puts the affirmative option first so the primary button is never a reject', () => {
    const card = buildAcpApprovalCard(REQUEST)
    expect(card?.options.map((o) => o.send)).toEqual(['once', 'always', 'rej'])
    expect(card?.options[0].label).toBe('Allow once')
  })

  it('carries the tool title and surfaces the command as the detail line', () => {
    const card = buildAcpApprovalCard(REQUEST)
    expect(card?.title).toBe('Run shell command')
    expect(card?.detail).toBe('rm -rf build')
  })

  it('sends the ACP optionId as the card send value', () => {
    const card = buildAcpApprovalCard(REQUEST)
    // The card hands `send` back untouched, so it must be the protocol id.
    expect(card?.options.every((o) => ['once', 'always', 'rej'].includes(o.send))).toBe(true)
  })

  it('prefers path over a serialized blob for file tools', () => {
    const card = buildAcpApprovalCard({
      toolCall: { title: 'Edit file', rawInput: { path: '/etc/hosts', body: 'x'.repeat(5000) } },
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }]
    })
    expect(card?.detail).toBe('/etc/hosts')
  })

  it('truncates an oversized detail instead of dumping a file body into the card', () => {
    const card = buildAcpApprovalCard({
      toolCall: { title: 'Write', rawInput: { body: 'x'.repeat(5000) } },
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }]
    })
    expect(card?.detail!.length).toBeLessThanOrEqual(300)
  })

  it('falls back to the tool kind, then a generic title', () => {
    const options = [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }]
    expect(buildAcpApprovalCard({ toolCall: { kind: 'fetch' }, options })?.title).toBe(
      'Allow fetch?'
    )
    expect(buildAcpApprovalCard({ options })?.title).toBe('Allow tool call?')
  })

  it('omits detail when the tool call carries no input', () => {
    const card = buildAcpApprovalCard({
      toolCall: { title: 'Think' },
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }]
    })
    expect(card?.detail).toBeUndefined()
  })

  it('drops options with no optionId — an unanswerable button must not render', () => {
    const card = buildAcpApprovalCard({
      toolCall: { title: 'x' },
      options: [{ name: 'Broken', kind: 'allow_once' }, { optionId: 'ok', name: 'Fine' }]
    })
    expect(card?.options).toEqual([{ label: 'Fine', send: 'ok' }])
  })

  it('returns null when there is nothing answerable, so the caller must cancel', () => {
    expect(buildAcpApprovalCard({ toolCall: { title: 'x' }, options: [] })).toBeNull()
    expect(buildAcpApprovalCard({ toolCall: { title: 'x' } })).toBeNull()
    expect(buildAcpApprovalCard(null)).toBeNull()
    expect(buildAcpApprovalCard(undefined)).toBeNull()
  })

  it('labels an option by kind or id when the agent omits a name', () => {
    const card = buildAcpApprovalCard({
      options: [{ optionId: 'o1', kind: 'allow_once' }, { optionId: 'o2' }]
    })
    expect(card?.options.map((o) => o.label)).toEqual(['allow_once', 'o2'])
  })
})

describe('buildAcpPermissionOutcome', () => {
  it('selects the chosen option', () => {
    expect(buildAcpPermissionOutcome('once')).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
  })

  it('cancels — never implicitly allows — when no option was chosen', () => {
    expect(buildAcpPermissionOutcome(null)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(buildAcpPermissionOutcome(undefined)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(buildAcpPermissionOutcome('')).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('isAcpGrantOption', () => {
  it('recognizes allow kinds and rejects everything else', () => {
    expect(isAcpGrantOption(REQUEST, 'once')).toBe(true)
    expect(isAcpGrantOption(REQUEST, 'always')).toBe(true)
    expect(isAcpGrantOption(REQUEST, 'rej')).toBe(false)
    expect(isAcpGrantOption(REQUEST, 'unknown-id')).toBe(false)
    expect(isAcpGrantOption(null, 'once')).toBe(false)
  })
})
