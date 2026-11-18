import { describe, expect, it } from 'vitest'
import {
  formatAutomationEventTrigger,
  formatAutomationTriggerOptions,
  parseAutomationEventTrigger
} from '../automations/automation-event-trigger-spec'

describe('--on "webhook.call ..."', () => {
  it('reads every filter, and asks the host to make the hook', () => {
    expect(
      parseAutomationEventTrigger(
        'webhook.call where="body.action in opened, reopened" where="headers.X-GitHub-Event = pull_request" where="body.draft !exists" contains="deploy now" pick=body.number,body.title subject-from=body.number subject=4512'
      )
    ).toEqual({
      id: '',
      source: 'webhook',
      event: 'call',
      rev: 0,
      where: [
        { path: 'body.action', op: 'in', values: ['opened', 'reopened'] },
        { path: 'headers.X-GitHub-Event', op: '=', values: ['pull_request'] },
        { path: 'body.draft', op: '!exists' }
      ],
      textContains: 'deploy now',
      pick: ['body.number', 'body.title'],
      subjectFrom: 'body.number',
      subject: '4512'
    })
    // One value may hold commas; only `in` lists.
    expect(
      parseAutomationEventTrigger('webhook.call where="body.title contains a, b"')
    ).toMatchObject({
      where: [{ path: 'body.title', op: 'contains', values: ['a, b'] }]
    })
  })

  it('formats back to the same rule', () => {
    const spec =
      'webhook.call where="body.action in opened,reopened" contains="deploy now" pick=body.number subject-from=body.number subject=4512'
    const rule = parseAutomationEventTrigger(spec)
    expect(formatAutomationEventTrigger(rule)).toBe(spec)
  })

  it.each([
    ['webhook.call in=C0123', 'Unknown filter "in="'],
    ['webhook.call where="body.action ~ x"', 'where= takes "<path> <op> <value>"'],
    ['webhook.call pick=a pick=b', 'needs one value for pick=']
  ])('refuses %j', (spec, message) => {
    expect(() => parseAutomationEventTrigger(spec)).toThrow(message)
  })

  it('shows key-handling guidance for a webhook-capable host', () => {
    const guide = formatAutomationTriggerOptions(undefined, { name: 'Scout', webhooks: true })
    expect(guide).toContain('webhook.call')
    expect(guide).toContain(
      'Never write a webhook URL yourself, and never ask for, repeat or accept a webhook key.'
    )
    expect(formatAutomationTriggerOptions(undefined, { name: 'Scout' })).not.toContain(
      'webhook.call'
    )
  })
})
