import { describe, expect, it } from 'vitest'
import { getEventTriggersFlag } from './automation-event-triggers-cli'
import { getOnceFlags } from './automation-once-flag'
import { watchPrCreateFlags } from './automation-watch-pr'

const NOW = Date.parse('2030-01-01T12:00:00.000Z')

function expand(entries: [string, string | boolean][]) {
  const flags = watchPrCreateFlags(new Map(entries), NOW)
  return {
    flags,
    rules: getEventTriggersFlag(flags)?.map(
      (rule) => `${rule.source}.${rule.event} ${'subject' in rule ? rule.subject : ''}`
    ),
    once: getOnceFlags(flags)
  }
}

describe('watchPrCreateFlags', () => {
  it('expands to one wait on every next-step event of the pull request, due in 2 hours', () => {
    const { flags, rules, once } = expand([
      ['pr', 'https://github.com/stablyai/orca/pull/482'],
      ['bot', 'ranger']
    ])
    expect(rules).toEqual([
      'github.ci_finished stablyai/orca#482',
      'github.pr_conflicted stablyai/orca#482',
      'github.pr_merged stablyai/orca#482',
      'github.pr_closed stablyai/orca#482',
      'github.review stablyai/orca#482',
      'github.review_comment stablyai/orca#482',
      'github.comment stablyai/orca#482'
    ])
    expect(once).toEqual({ by: Date.parse('2030-01-01T14:00:00.000Z') })
    expect(flags.get('name')).toBe('PR stablyai/orca#482')
    expect(flags.get('bot')).toBe('ranger')
    expect(flags.has('pr')).toBe(false)
    expect(String(flags.get('prompt'))).toContain('deadline came first')
  })

  it('takes --for or --by for the deadline, and the caller name and prompt', () => {
    const forty = expand([
      ['pr', 'stablyai/orca#482'],
      ['for', '1h30m'],
      ['name', 'Watch'],
      ['prompt', 'Fix attempt 1 of 2']
    ])
    expect(forty.once).toEqual({ by: Date.parse('2030-01-01T13:30:00.000Z') })
    expect(forty.flags.has('for')).toBe(false)
    expect(forty.flags.get('name')).toBe('Watch')
    expect(String(forty.flags.get('prompt'))).toMatch(/^Fix attempt 1 of 2\n\n/)
    expect(
      expand([
        ['pr', 'a/b#1'],
        ['by', '2030-01-02T00:00:00Z']
      ]).once
    ).toEqual({
      by: Date.parse('2030-01-02T00:00:00Z')
    })
  })

  it('refuses what is not one pull request or one deadline', () => {
    expect(() => expand([['pr', 'stablyai/orca']])).toThrow(/one pull request/)
    expect(() => expand([['pr', 'https://github.com/a/b/issues/1']])).toThrow(/one pull request/)
    expect(() =>
      expand([
        ['pr', 'a/b#1'],
        ['for', '2d']
      ])
    ).toThrow(/--for takes/)
    expect(() =>
      expand([
        ['pr', 'a/b#1'],
        ['for', '0m']
      ])
    ).toThrow(/--for takes/)
    expect(() =>
      expand([
        ['pr', 'a/b#1'],
        ['for', '1h'],
        ['by', '2030-01-02T00:00:00Z']
      ])
    ).toThrow(/not both/)
  })
})
