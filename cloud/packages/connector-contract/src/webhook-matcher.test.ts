import { describe, expect, it } from 'vitest'
import {
  WEBHOOK_BODY_LIMITS,
  matchesWebhookCall,
  webhookBodyFits,
  webhookCallSubject,
  webhookFiltersProblem,
  webhookPicks,
  type WebhookCallView,
  type WebhookFilters,
  type WebhookWhere
} from './webhook-matcher.js'

// Shaped like a Sentry issue alert.
const sentry: WebhookCallView = {
  headers: { 'sentry-hook-resource': 'event_alert', 'content-type': 'application/json' },
  body: {
    action: 'triggered',
    data: {
      event: {
        issue_id: 4512,
        level: 'error',
        environment: 'production',
        title: 'TypeError: x is undefined',
        tags: ['web', 'checkout'],
        release: null,
        count: '12'
      }
    }
  }
}

const matches = (where: WebhookWhere[], call = sentry) => matchesWebhookCall({ where }, call)

describe('matchesWebhookCall', () => {
  it('ANDs where clauses over dot paths', () => {
    expect(matches([{ path: 'body.data.event.level', op: '=', values: ['error'] }])).toBe(true)
    expect(
      matches([
        { path: 'body.data.event.level', op: 'in', values: ['warning', 'error'] },
        { path: 'body.data.event.environment', op: '!=', values: ['staging'] }
      ])
    ).toBe(true)
    expect(
      matches([
        { path: 'body.data.event.level', op: '=', values: ['error'] },
        { path: 'body.data.event.environment', op: '=', values: ['staging'] }
      ])
    ).toBe(false)
  })

  it('compares strings exactly and numbers as numbers', () => {
    expect(matches([{ path: 'body.data.event.level', op: '=', values: ['Error'] }])).toBe(false)
    expect(matches([{ path: 'body.data.event.issue_id', op: '=', values: ['4512.0'] }])).toBe(true)
    expect(matches([{ path: 'body.data.event.count', op: '=', values: ['12'] }])).toBe(true)
    expect(matches([{ path: 'body.data.event.count', op: '=', values: ['12.0'] }])).toBe(false)
    expect(matches([{ path: 'body.data.event.title', op: '=', values: ['0'] }])).toBe(false)
  })

  it('never equates two different ids through a lossy number', () => {
    const call: WebhookCallView = {
      headers: {},
      body: JSON.parse(
        '{"code":"0042","n":42,"big":"9007199254740993","bigN":9007199254740993,"huge":"1e309","hugeN":1e309}'
      )
    }
    const equal = (path: string, value: string) =>
      matches([{ path: `body.${path}`, op: '=', values: [value] }], call)
    expect(equal('code', '42')).toBe(false)
    expect(equal('n', '0042')).toBe(true)
    expect(equal('big', '9007199254740992')).toBe(false)
    expect(equal('bigN', '9007199254740993')).toBe(false)
    expect(equal('bigN', '9007199254740992')).toBe(false)
    expect(equal('huge', '2e309')).toBe(false)
    expect(equal('hugeN', '1e309')).toBe(false)
    expect(matches([{ path: 'body.bigN', op: '!=', values: ['9007199254740993'] }], call)).toBe(
      true
    )
    expect(webhookCallSubject({ subjectFrom: 'body.bigN' }, call)).toBeUndefined()
  })

  it('matches an array when any item does, and != only when none does', () => {
    expect(matches([{ path: 'body.data.event.tags', op: '=', values: ['checkout'] }])).toBe(true)
    expect(matches([{ path: 'body.data.event.tags', op: '!=', values: ['checkout'] }])).toBe(false)
    expect(matches([{ path: 'body.data.event.tags[1]', op: '=', values: ['checkout'] }])).toBe(true)
    expect(matches([{ path: 'body.data.event.tags[2]', op: 'exists' }])).toBe(false)
  })

  it('reads missing and null as absent: only != and !exists match them', () => {
    for (const path of [
      'body.data.event.release',
      'body.data.missing',
      'body.data.event.level.x'
    ]) {
      expect(matches([{ path, op: '!exists' }])).toBe(true)
      expect(matches([{ path, op: '!=', values: ['x'] }])).toBe(true)
      expect(matches([{ path, op: 'exists' }])).toBe(false)
      expect(matches([{ path, op: '=', values: ['null'] }])).toBe(false)
      expect(matches([{ path, op: 'contains', values: ['n'] }])).toBe(false)
    }
  })

  it('reads only own properties', () => {
    expect(matches([{ path: 'body.data.toString', op: 'exists' }])).toBe(false)
    expect(matches([{ path: 'body.data.event.tags.length', op: 'exists' }])).toBe(false)
  })

  it('finds a substring in any case with contains', () => {
    expect(
      matches([{ path: 'body.data.event.title', op: 'contains', values: ['typeerror'] }])
    ).toBe(true)
    expect(matches([{ path: 'body.data.event.tags', op: 'contains', values: ['CHECK'] }])).toBe(
      true
    )
    expect(matches([{ path: 'body.data.event', op: 'contains', values: ['error'] }])).toBe(false)
  })

  it('names headers in any case', () => {
    expect(
      matches([{ path: 'headers.Sentry-Hook-Resource', op: '=', values: ['event_alert'] }])
    ).toBe(true)
  })

  it('reads a form body, whose repeated keys are arrays', () => {
    const form = { headers: {}, body: { text: 'deploy web', label: ['ops', 'urgent'] } }
    expect(matches([{ path: 'body.label', op: '=', values: ['urgent'] }], form)).toBe(true)
  })

  it('takes contains= over the body text, and a text body only as a whole', () => {
    const text = { headers: {}, body: 'Disk FULL on db-1' }
    expect(matchesWebhookCall({ textContains: 'disk full' }, text)).toBe(true)
    expect(matches([{ path: 'body', op: 'contains', values: ['db-1'] }], text)).toBe(true)
    expect(matches([{ path: 'body.0', op: 'exists' }], text)).toBe(false)
    expect(matchesWebhookCall({ textContains: 'TYPEERROR' }, sentry)).toBe(true)
    expect(matchesWebhookCall({ textContains: 'rollback' }, sentry)).toBe(false)
  })

  it('never reads a forbidden or unrooted path', () => {
    const polluted = { headers: {}, body: JSON.parse('{"__proto__": {"x": "1"}, "y": "1"}') }
    expect(matches([{ path: 'body.__proto__.x', op: 'exists' }], polluted)).toBe(false)
    expect(matches([{ path: 'y', op: 'exists' }], polluted)).toBe(false)
  })
})

describe('webhookBodyFits', () => {
  const nested = (depth: number) => JSON.parse(`${'['.repeat(depth)}${']'.repeat(depth)}`)

  it('holds a body to its depth and node budget without recursing', () => {
    expect(webhookBodyFits(nested(WEBHOOK_BODY_LIMITS.maxDepth))).toBe(true)
    expect(webhookBodyFits(nested(WEBHOOK_BODY_LIMITS.maxDepth + 1))).toBe(false)
    expect(webhookBodyFits(nested(100_000))).toBe(false)
    expect(webhookBodyFits(new Array(WEBHOOK_BODY_LIMITS.maxNodes - 1).fill(0))).toBe(true)
    expect(webhookBodyFits(new Array(WEBHOOK_BODY_LIMITS.maxNodes).fill(0))).toBe(false)
    expect(webhookBodyFits('text')).toBe(true)
  })

  it('matches a body past it without exhausting the stack, and contains= never', () => {
    // 20,001 bytes, far inside the body cap.
    const call = { headers: {}, body: nested(10_000) }
    expect(matchesWebhookCall({}, call)).toBe(true)
    expect(matchesWebhookCall({ where: [{ path: 'body[0]', op: 'exists' }] }, call)).toBe(true)
    expect(matchesWebhookCall({ textContains: '[' }, call)).toBe(false)
    expect(webhookPicks({ pick: ['body[0][0]'] }, call)).toHaveLength(1)
  })
})

describe('subject-from= and subject=', () => {
  it('takes each call its subject from the payload', () => {
    expect(webhookCallSubject({ subjectFrom: 'body.data.event.issue_id' }, sentry)).toBe('4512')
    expect(webhookCallSubject({ subjectFrom: 'body.data.event.title' }, sentry)).toBe(
      'TypeError: x is undefined'
    )
    expect(webhookCallSubject({}, sentry)).toBeUndefined()
  })

  it('folds nothing for a missing, null, object, empty or overlong value', () => {
    for (const subjectFrom of ['body.data.nope', 'body.data.event.release', 'body.data.event']) {
      expect(webhookCallSubject({ subjectFrom }, sentry)).toBeUndefined()
    }
    const odd = { headers: {}, body: { empty: '', long: 'x'.repeat(257) } }
    expect(webhookCallSubject({ subjectFrom: 'body.empty' }, odd)).toBeUndefined()
    expect(webhookCallSubject({ subjectFrom: 'body.long' }, odd)).toBeUndefined()
  })

  it('keeps subject= a fixed value the subject must equal, in any case', () => {
    const filters = { subjectFrom: 'body.data.event.title', subject: 'typeerror: X is undefined' }
    expect(matchesWebhookCall(filters, sentry)).toBe(true)
    expect(matchesWebhookCall({ ...filters, subject: '4512' }, sentry)).toBe(false)
  })
})

describe('webhookPicks', () => {
  it('returns the picked fields the call has, in order', () => {
    expect(
      webhookPicks(
        { pick: ['body.data.event.title', 'body.nope', 'body.data.event.tags', 'headers.x'] },
        sentry
      )
    ).toEqual([
      { path: 'body.data.event.title', value: 'TypeError: x is undefined' },
      { path: 'body.data.event.tags', value: ['web', 'checkout'] }
    ])
  })
})

describe('webhookFiltersProblem', () => {
  it('accepts filters within the caps', () => {
    expect(
      webhookFiltersProblem({
        where: [
          { path: 'body.items[0].id', op: 'in', values: ['1', '2'] },
          { path: 'headers.x-github-event', op: 'exists' }
        ],
        pick: ['body.title'],
        subjectFrom: 'body.id',
        subject: '42',
        textContains: 'deploy'
      })
    ).toBeNull()
  })

  it.each<[WebhookFilters, string]>([
    [{ where: [{ path: 'body.a.__proto__', op: '=', values: ['x'] }] }, `"body.a.__proto__"`],
    [{ where: [{ path: 'body.constructor', op: 'exists' }] }, `"body.constructor"`],
    [{ pick: ['data.title'] }, `"data.title" isn't a path`],
    [{ subjectFrom: 'body.a b' }, `"body.a b"`],
    [{ subjectFrom: 'body..a' }, `"body..a"`],
    [{ where: [{ path: 'body.a', op: '=', values: ['x', 'y'] }] }, 'takes one value'],
    [{ where: [{ path: 'body.a', op: 'in', values: [] }] }, 'takes 1 to 10 values'],
    [{ where: [{ path: 'body.a', op: 'exists', values: ['x'] }] }, 'takes no value'],
    [{ where: [{ path: 'body.a', op: '=', values: [''] }] }, '1 to 200 characters'],
    [{ subject: '42' }, 'subject= needs subject-from='],
    [
      { where: Array.from({ length: 9 }, () => ({ path: 'body.a', op: 'exists' })) },
      'at most 8 where= clauses'
    ]
  ])('refuses %j', (filters, message) => {
    expect(webhookFiltersProblem(filters)).toContain(message)
  })
})
