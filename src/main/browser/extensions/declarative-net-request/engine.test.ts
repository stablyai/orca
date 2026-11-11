import { describe, expect, it } from 'vitest'
import { createDnrRequestState } from './request-state'
import { DnrEngine, type DnrEvaluateOptions } from './engine'
import type { DnrRequestInfo } from './request-context'
import type { DnrRule, DnrRulesetSource } from './rule-compilation/rule-types'
import { buildDnrRuleset } from './rule-compilation/ruleset-builder'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

type RulesetSpec = { source?: DnrRulesetSource; rules: Partial<DnrRule>[] }

function engineWith(extensions: Record<string, RulesetSpec[]>): DnrEngine {
  const engine = new DnrEngine()
  let installTime = 0
  for (const [extensionId, rulesets] of Object.entries(extensions)) {
    engine.setExtension(extensionId, { installTime: installTime++ })
    for (const spec of rulesets) {
      const source = spec.source ?? { kind: 'static', id: 'main', manifestIndex: 0 }
      const rules = spec.rules.map((rule, index) => ({
        id: index + 1,
        condition: {},
        action: { type: 'block' },
        ...rule
      }))
      const built = buildDnrRuleset(rules, { extensionId, source, invalidRules: 'error' })
      if (!built.ok) {
        throw new Error(built.error.message)
      }
      engine.setRuleset(extensionId, source, built.index)
    }
  }
  return engine
}

function request(url: string, overrides: Partial<DnrRequestInfo> = {}): DnrRequestInfo {
  return {
    url,
    method: 'GET',
    type: 'script',
    initiator: 'https://site.example',
    tabId: 1,
    ...overrides
  }
}

function outcome(engine: DnrEngine, info: DnrRequestInfo, options?: DnrEvaluateOptions): string[] {
  const result = engine.evaluateBeforeRequest(info, createDnrRequestState(), options)
  return result.actions.map(
    (action) =>
      `${action.type}:${action.rule.extensionId.slice(0, 1)}${action.rule.ruleId}${action.redirectUrl ? `>${action.redirectUrl}` : ''}`
  )
}

const ruleset = (...rules: Partial<DnrRule>[]): RulesetSpec[] => [{ rules }]

describe('single extension precedence', () => {
  it('prefers the later static ruleset, then dynamic, then session on exact ties', () => {
    const redirect = (url: string): Partial<DnrRule> => ({
      action: { type: 'redirect', redirect: { url } },
      condition: { urlFilter: 'x' }
    })
    const engine = engineWith({
      [OLD]: [
        { source: { kind: 'session' }, rules: [redirect('https://session.example/')] },
        { source: { kind: 'dynamic' }, rules: [redirect('https://dynamic.example/')] },
        {
          source: { kind: 'static', id: 'first', manifestIndex: 0 },
          rules: [redirect('https://first.example/')]
        },
        {
          source: { kind: 'static', id: 'second', manifestIndex: 1 },
          rules: [redirect('https://second.example/')]
        }
      ]
    })
    expect(outcome(engine, request('https://x.example/'))).toEqual([
      'redirect:a1>https://second.example/'
    ])
  })

  it('lets a redirect that cannot apply mask lower-priority rules, as Chromium does', () => {
    const engine = engineWith({
      [OLD]: ruleset(
        {
          priority: 2,
          action: { type: 'redirect', redirect: { url: 'https://x.example/' } },
          condition: { urlFilter: 'x' }
        },
        { condition: { urlFilter: 'x' } }
      )
    })
    // Redirecting to itself yields no action, and the block underneath is not consulted.
    expect(outcome(engine, request('https://x.example/'))).toEqual([])
    expect(outcome(engine, request('https://x.example/', { type: 'websocket' }))).toEqual([])
    expect(outcome(engine, request('https://x.example/other'))).toEqual([
      'redirect:a1>https://x.example/'
    ])
  })

  it('resolves extensionPath, transform and regexSubstitution redirects', () => {
    const engine = engineWith({
      [OLD]: ruleset(
        {
          action: { type: 'redirect', redirect: { extensionPath: '/stub.js' } },
          condition: { urlFilter: 'stub' }
        },
        {
          action: {
            type: 'redirect',
            redirect: { transform: { queryTransform: { removeParams: ['utm_source'] } } }
          },
          condition: { urlFilter: 'utm_source=', resourceTypes: ['main_frame'] }
        },
        {
          action: { type: 'redirect', redirect: { regexSubstitution: 'https://\\1.example/\\2' } },
          condition: { regexFilter: '^https://go\\.example/(\\w+)/(.*)$' }
        }
      )
    })
    expect(outcome(engine, request('https://x.example/stub'))).toEqual([
      `redirect:a1>chrome-extension://${OLD}/stub.js`
    ])
    expect(
      outcome(
        engine,
        request('https://x.example/?a=1&utm_source=z&b=2', { type: 'main_frame', initiator: null })
      )
    ).toEqual(['redirect:a2>https://x.example/?a=1&b=2'])
    expect(outcome(engine, request('https://go.example/news/today'))).toEqual([
      'redirect:a3>https://news.example/today'
    ])
  })
})

describe('conditions', () => {
  it('uses registrable domains for domainType; opaque initiators are third-party', () => {
    const engine = engineWith({
      [OLD]: ruleset(
        { condition: { urlFilter: 'first', domainType: 'firstParty' } },
        { condition: { urlFilter: 'third', domainType: 'thirdParty' } }
      )
    })
    const first = { initiator: 'https://www.example.co.uk' }
    expect(outcome(engine, request('https://cdn.example.co.uk/first', first))).toEqual(['block:a1'])
    expect(outcome(engine, request('https://cdn.example.co.uk/third', first))).toEqual([])
    expect(outcome(engine, request('https://other.co.uk/third', first))).toEqual(['block:a2'])
    // github.io is a private suffix, so two pages there are different sites.
    expect(
      outcome(engine, request('https://a.github.io/third', { initiator: 'https://b.github.io' }))
    ).toEqual(['block:a2'])
    expect(outcome(engine, request('https://x.example/third', { initiator: null }))).toEqual([
      'block:a2'
    ])
  })

  it('matches tab ids on session rules and top domains against the outermost frame', () => {
    const engine = engineWith({
      [OLD]: [
        { source: { kind: 'session' }, rules: [{ condition: { urlFilter: 'tab', tabIds: [7] } }] },
        { rules: [{ condition: { urlFilter: 'top', topDomains: ['news.example'] } }] }
      ]
    })
    expect(outcome(engine, request('https://x.example/tab', { tabId: 7 }))).toEqual(['block:a1'])
    expect(outcome(engine, request('https://x.example/tab', { tabId: 8 }))).toEqual([])
    const nested = { initiator: 'https://ads.example', topFrameOrigin: 'https://www.news.example' }
    expect(outcome(engine, request('https://x.example/top', nested))).toEqual(['block:a1'])
    expect(
      outcome(engine, request('https://x.example/top', { initiator: 'https://www.news.example' }))
    ).toEqual(['block:a1'])
  })

  it('does not disable regex rules through updateStaticRules, matching Chromium', () => {
    const engine = engineWith({
      [OLD]: ruleset({ condition: { urlFilter: 'u' } }, { condition: { regexFilter: 'r' } })
    })
    engine.setDisabledStaticRuleIds(OLD, 'main', [1, 2])
    expect(outcome(engine, request('https://x.example/u'))).toEqual([])
    expect(outcome(engine, request('https://x.example/r'))).toEqual(['block:a2'])
  })
})

describe('across extensions', () => {
  it('drops redirects without host access but keeps blocks', () => {
    const engine = engineWith({
      [OLD]: ruleset(
        {
          action: { type: 'redirect', redirect: { url: 'https://r.example/' } },
          condition: { urlFilter: 'r' }
        },
        {
          condition: { urlFilter: 'b' }
        }
      )
    })
    const withheld = { hostAccess: () => 'withheld' as const }
    const result = engine.evaluateBeforeRequest(
      request('https://x.example/r'),
      createDnrRequestState(),
      withheld
    )
    expect(result).toMatchObject({ actions: [], withheldExtensionIds: [OLD] })
    expect(outcome(engine, request('https://x.example/b'), withheld)).toEqual(['block:a2'])
  })
})
