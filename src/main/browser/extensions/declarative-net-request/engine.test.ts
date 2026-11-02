import { describe, expect, it } from 'vitest'
import { createDnrRequestState, DnrEngine, type DnrEvaluateOptions } from './engine'
import type { DnrRequestInfo } from './request-context'
import type { DnrRule, DnrRulesetSource } from './rule-types'
import { buildDnrRuleset } from './ruleset-builder'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

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
  it('skips main frames unless resourceTypes names them', () => {
    const engine = engineWith({ [OLD]: ruleset({ condition: { urlFilter: 'ads' } }) })
    expect(outcome(engine, request('https://x.example/ads.js'))).toEqual(['block:a1'])
    expect(
      outcome(engine, request('https://x.example/ads', { type: 'main_frame', initiator: null }))
    ).toEqual([])
  })

  it('breaks equal priorities by action: allow > allowAllRequests > block > upgradeScheme > redirect', () => {
    const redirect = {
      action: { type: 'redirect' as const, redirect: { url: 'https://r.example/' } },
      condition: { urlFilter: 'x' }
    }
    const upgrade = { action: { type: 'upgradeScheme' as const }, condition: { urlFilter: 'x' } }
    const block = { action: { type: 'block' as const }, condition: { urlFilter: 'x' } }
    const allow = { action: { type: 'allow' as const }, condition: { urlFilter: 'x' } }
    expect(
      outcome(engineWith({ [OLD]: ruleset(redirect, upgrade) }), request('http://x.example/'))
    ).toEqual(['upgradeScheme:a2>https://x.example/'])
    expect(
      outcome(
        engineWith({ [OLD]: ruleset(redirect, upgrade, block) }),
        request('http://x.example/')
      )
    ).toEqual(['block:a3'])
    expect(
      outcome(engineWith({ [OLD]: ruleset(block, allow) }), request('http://x.example/'))
    ).toEqual(['allow:a2'])
  })

  it('lets a higher priority beat the action order', () => {
    const engine = engineWith({
      [OLD]: ruleset(
        { action: { type: 'allow' }, condition: { urlFilter: 'x' } },
        { priority: 2, condition: { urlFilter: 'x' } }
      )
    })
    expect(outcome(engine, request('https://x.example/'))).toEqual(['block:a2'])
  })

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

  it('collapses blocked images and frames', () => {
    const engine = engineWith({ [OLD]: ruleset({ condition: { urlFilter: 'ad' } }) })
    expect(outcome(engine, request('https://x.example/ad.png', { type: 'image' }))).toEqual([
      'collapse:a1'
    ])
    expect(outcome(engine, request('https://x.example/ad', { type: 'sub_frame' }))).toEqual([
      'collapse:a1'
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

  it('upgrades only http and ftp', () => {
    const engine = engineWith({
      [OLD]: ruleset({ action: { type: 'upgradeScheme' }, condition: {} })
    })
    expect(outcome(engine, request('http://x.example:8080/a?b#c'))).toEqual([
      'upgradeScheme:a1>https://x.example:8080/a?b#c'
    ])
    expect(outcome(engine, request('ws://x.example/', { type: 'websocket' }))).toEqual([])
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

  it("never acts on chrome-extension:// URLs or on other extensions' requests", () => {
    const engine = engineWith({ [OLD]: ruleset({ condition: {} }) })
    expect(outcome(engine, request(`chrome-extension://${NEW}/x.js`))).toEqual([])
    expect(
      outcome(engine, request('https://x.example/', { initiator: `chrome-extension://${NEW}` }))
    ).toEqual([])
    expect(
      outcome(engine, request('https://x.example/', { initiator: `chrome-extension://${OLD}` }))
    ).toEqual(['block:a1'])
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

  it('lets the most specific initiator domain win and ignores exclusions for opaque initiators', () => {
    const engine = engineWith({
      [OLD]: ruleset(
        {
          condition: {
            initiatorDomains: ['example.com'],
            excludedInitiatorDomains: ['safe.example.com']
          }
        },
        {
          condition: { urlFilter: 'generic', excludedInitiatorDomains: ['example.com'] }
        }
      )
    })
    expect(
      outcome(engine, request('https://t.example/', { initiator: 'https://www.example.com' }))
    ).toEqual(['block:a1'])
    expect(
      outcome(engine, request('https://t.example/', { initiator: 'https://a.safe.example.com' }))
    ).toEqual([])
    expect(outcome(engine, request('https://t.example/', { initiator: null }))).toEqual([])
    expect(outcome(engine, request('https://t.example/generic', { initiator: null }))).toEqual([
      'block:a2'
    ])
  })

  it('matches request domains and their subdomains', () => {
    const many = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'tracker.example']
    const engine = engineWith({
      [OLD]: ruleset({
        condition: { requestDomains: many, excludedRequestDomains: ['ok.tracker.example'] }
      })
    })
    expect(outcome(engine, request('https://px.tracker.example/p'))).toEqual(['block:a1'])
    expect(outcome(engine, request('https://ok.tracker.example/p'))).toEqual([])
    expect(outcome(engine, request('https://nottracker.example/p'))).toEqual([])
  })

  it('checks methods, treating non-HTTP schemes as their own method', () => {
    const engine = engineWith({
      [OLD]: ruleset(
        { condition: { urlFilter: 'm', requestMethods: ['post'] } },
        { condition: { urlFilter: 'w', excludedRequestMethods: ['get'] } }
      )
    })
    expect(outcome(engine, request('https://x.example/m', { method: 'post' }))).toEqual([
      'block:a1'
    ])
    expect(outcome(engine, request('https://x.example/m'))).toEqual([])
    expect(outcome(engine, request('wss://x.example/w', { type: 'websocket' }))).toEqual([
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
  it('ranks block over redirect over allow regardless of install order', () => {
    const engine = engineWith({
      [OLD]: ruleset({ condition: { urlFilter: 'x' } }),
      [NEW]: ruleset({
        priority: 99,
        action: { type: 'redirect', redirect: { url: 'https://r.example/' } },
        condition: { urlFilter: 'x' }
      })
    })
    expect(outcome(engine, request('https://x.example/'))).toEqual(['block:a1'])
  })

  it('gives ties to the most recently installed extension', () => {
    const redirect = (url: string): RulesetSpec[] =>
      ruleset({ action: { type: 'redirect', redirect: { url } }, condition: { urlFilter: 'x' } })
    const engine = engineWith({
      [OLD]: redirect('https://old.example/'),
      [NEW]: redirect('https://new.example/')
    })
    expect(outcome(engine, request('https://x.example/'))).toEqual([
      'redirect:b1>https://new.example/'
    ])
  })

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
