import { describe, expect, it } from 'vitest'
import { createDnrRequestState, DnrEngine } from './engine'
import { applyDnrRequestHeaderActions, applyDnrResponseHeaderActions } from './header-modification'
import type { DnrRequestInfo } from './request-context'
import type { DnrRule } from './rule-types'
import { buildDnrRuleset } from './ruleset-builder'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function engineWith(extensions: Record<string, Partial<DnrRule>[]>): DnrEngine {
  const engine = new DnrEngine()
  let installTime = 0
  for (const [extensionId, rules] of Object.entries(extensions)) {
    engine.setExtension(extensionId, { installTime: installTime++ })
    const source = { kind: 'static', id: 'main', manifestIndex: 0 } as const
    const full = rules.map((rule, index) => ({
      id: index + 1,
      condition: {},
      action: { type: 'block' },
      ...rule
    }))
    const built = buildDnrRuleset(full, { extensionId, source, invalidRules: 'error' })
    if (!built.ok) {
      throw new Error(built.error.message)
    }
    engine.setRuleset(extensionId, source, built.index)
  }
  return engine
}

const request = (url: string, overrides: Partial<DnrRequestInfo> = {}): DnrRequestInfo => ({
  url,
  method: 'GET',
  type: 'script',
  initiator: 'https://site.example',
  tabId: 1,
  ...overrides
})

const setHeader = (header: string, value: string, priority = 1): Partial<DnrRule> => ({
  priority,
  action: { type: 'modifyHeaders', requestHeaders: [{ header, operation: 'set', value }] },
  condition: {}
})

describe('allowAllRequests', () => {
  const engine = engineWith({
    [OLD]: [
      {
        priority: 2,
        action: { type: 'allowAllRequests' },
        condition: { urlFilter: '||trusted.example^', resourceTypes: ['main_frame'] }
      },
      { condition: { urlFilter: 'ads' } },
      { priority: 3, condition: { urlFilter: 'malware' } }
    ]
  })
  const frame = engine.evaluateFrameCommit({
    url: 'https://trusted.example/',
    isPost: false,
    parentOrigin: null,
    tabId: 1
  })
  const child = engine.evaluateFrameCommit({
    url: 'https://embed.example/',
    isPost: false,
    parentOrigin: 'https://trusted.example',
    tabId: 1,
    parentState: frame
  })

  it('matches the navigation itself', () => {
    const navigation = request('https://trusted.example/', { type: 'main_frame', initiator: null })
    expect(engine.evaluateBeforeRequest(navigation, createDnrRequestState()).actions[0]?.type).toBe(
      'allowAllRequests'
    )
  })

  it('allows lower-priority blocks in the frame and its children, not higher ones', () => {
    const fromFrame = (url: string, frameAllow = frame): string | undefined =>
      engine.evaluateBeforeRequest(
        request(url, { initiator: 'https://trusted.example' }),
        createDnrRequestState(),
        { frameAllow }
      ).actions[0]?.type
    expect(fromFrame('https://cdn.example/ads.js')).toBe('allowAllRequests')
    expect(fromFrame('https://cdn.example/ads.js', child)).toBe('allowAllRequests')
    expect(fromFrame('https://cdn.example/malware.js')).toBe('block')
    expect(fromFrame('https://cdn.example/ads.js', new Map())).toBe('block')
  })

  it('stops applying once the ruleset is replaced', () => {
    const rebuilt = buildDnrRuleset(
      [{ id: 1, condition: { urlFilter: 'ads' }, action: { type: 'block' } }],
      {
        extensionId: OLD,
        source: { kind: 'static', id: 'main', manifestIndex: 0 },
        invalidRules: 'error'
      }
    )
    const local = engineWith({
      [OLD]: [
        { action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'] } }
      ]
    })
    const state = local.evaluateFrameCommit({
      url: 'https://a.example/',
      isPost: false,
      parentOrigin: null,
      tabId: 1
    })
    if (!rebuilt.ok) {
      throw new Error('rebuild failed')
    }
    local.setRuleset(OLD, { kind: 'static', id: 'main', manifestIndex: 0 }, rebuilt.index)
    const result = local.evaluateBeforeRequest(
      request('https://x.example/ads'),
      createDnrRequestState(),
      { frameAllow: state }
    )
    expect(result.actions[0]?.type).toBe('block')
  })
})

describe('modifyHeaders', () => {
  it('returns header actions highest priority first, skipping those at or below a matching allow', () => {
    const engine = engineWith({
      [OLD]: [
        setHeader('x-low', '1', 1),
        setHeader('x-high', '1', 5),
        { priority: 2, action: { type: 'allow' }, condition: {} }
      ]
    })
    const result = engine.evaluateBeforeRequest(
      request('https://x.example/'),
      createDnrRequestState()
    )
    expect(result.actions.map((action) => `${action.type}:${action.rule.ruleId}`)).toEqual([
      'modifyHeaders:2'
    ])
  })

  it('matches a rule once when several of its domains cover the request', () => {
    const domains = ['example.com', 'sub.example.com', 'example.com']
    const engine = engineWith({
      [OLD]: [
        { ...setHeader('x-url', '1'), condition: { requestDomains: domains } },
        {
          ...setHeader('x-regex', '1'),
          condition: { regexFilter: '.*', initiatorDomains: domains }
        }
      ]
    })
    const { actions } = engine.evaluateBeforeRequest(
      request('https://a.sub.example.com/', { initiator: 'https://sub.example.com' }),
      createDnrRequestState()
    )
    expect(actions.map((action) => action.rule.ruleId)).toEqual([2, 1])
  })

  it('is suppressed entirely by a block from any extension', () => {
    const engine = engineWith({ [OLD]: [{ condition: {} }], [NEW]: [setHeader('x', '1', 9)] })
    expect(
      engine.evaluateBeforeRequest(request('https://x.example/'), createDnrRequestState())
        .actions[0]?.type
    ).toBe('block')
  })

  it('applies the newer extension first and lets it win conflicting sets', () => {
    const engine = engineWith({
      [OLD]: [setHeader('user-agent', 'old')],
      [NEW]: [setHeader('User-Agent', 'new')]
    })
    const { actions } = engine.evaluateBeforeRequest(
      request('https://x.example/'),
      createDnrRequestState()
    )
    expect(actions.map((action) => action.rule.extensionId)).toEqual([NEW, OLD])
    const applied = applyDnrRequestHeaderActions({ 'User-Agent': 'browser' }, actions)
    expect(applied.headers).toEqual({ 'User-Agent': 'new' })
    expect(applied.appliedActions.map((action) => action.rule.extensionId)).toEqual([NEW])
  })
})

describe('header application rules', () => {
  const action = (
    extensionId: string,
    requestHeaders: { header: string; operation: 'append' | 'set' | 'remove'; value?: string }[]
  ) => ({
    type: 'modifyHeaders' as const,
    rule: { extensionId, rulesetId: 'main', ruleId: 1 },
    indexPriority: 256,
    rulesetOrdinal: 1,
    requestHeaders,
    responseHeaders: requestHeaders
  })

  it('joins appends with the header-specific delimiter', () => {
    const { headers } = applyDnrRequestHeaderActions({ cookie: 'a=1', accept: 'text/html' }, [
      action(OLD, [
        { header: 'cookie', operation: 'append', value: 'b=2' },
        { header: 'accept', operation: 'append', value: '*/*' }
      ])
    ])
    expect(headers).toEqual({ cookie: 'a=1; b=2', accept: 'text/html, */*' })
  })

  it('lets set be followed only by appends from the same extension, and remove by nothing', () => {
    const { headers } = applyDnrRequestHeaderActions({}, [
      action(NEW, [{ header: 'cookie', operation: 'set', value: 'a=1' }]),
      action(NEW, [{ header: 'cookie', operation: 'append', value: 'b=2' }]),
      action(OLD, [{ header: 'cookie', operation: 'append', value: 'c=3' }]),
      action(OLD, [{ header: 'x-gone', operation: 'remove' }]),
      action(NEW, [{ header: 'x-gone', operation: 'set', value: 'back' }])
    ])
    expect(headers).toEqual({ cookie: 'a=1; b=2' })
  })

  it('appends response header lines and replaces them on set', () => {
    const { headers } = applyDnrResponseHeaderActions(
      { 'Content-Security-Policy': ["default-src 'self'"], 'Set-Cookie': ['a=1', 'b=2'] },
      [
        action(OLD, [
          { header: 'content-security-policy', operation: 'append', value: "script-src 'none'" },
          { header: 'set-cookie', operation: 'remove' }
        ])
      ]
    )
    expect(headers).toEqual({
      'Content-Security-Policy': ["default-src 'self'", "script-src 'none'"]
    })
  })
})

describe('headers-received stage', () => {
  it.each([
    ['a?b', 'ab', true],
    ['a?b', 'acb', true],
    ['a?b', 'accb', false],
    ['a\\?b', 'a?b', true],
    ['a\\*b', 'a*b', true],
    ['a\\*b', 'axb', false],
    ['x\\', 'x\\', true],
    ['*a?b*', 'aaaabbb', true]
  ])('matches response value %s against %s as %s', (pattern, value, matches) => {
    const engine = engineWith({
      [OLD]: [{ condition: { responseHeaders: [{ header: 'x-value', values: [pattern] }] } }]
    })
    const result = engine.evaluateHeadersReceived(
      request('https://site.example/'),
      { 'X-Value': [value] },
      createDnrRequestState()
    )
    expect(result.actions[0]?.type === 'block').toBe(matches)
  })

  it('matches response-header conditions only once headers arrive', () => {
    const engine = engineWith({
      [OLD]: [
        {
          condition: {
            urlFilter: 'x',
            responseHeaders: [{ header: 'content-type', values: ['text/*'] }]
          }
        }
      ]
    })
    const state = createDnrRequestState()
    const info = request('https://x.example/x')
    expect(engine.evaluateBeforeRequest(info, state).actions).toEqual([])
    expect(
      engine.evaluateHeadersReceived(info, { 'Content-Type': ['application/json'] }, state).actions
    ).toEqual([])
    expect(
      engine.evaluateHeadersReceived(info, { 'Content-Type': ['TEXT/HTML; charset=utf-8'] }, state)
        .actions[0]?.type
    ).toBe('block')
  })

  it('splits comma lists like net does before matching values', () => {
    const engine = engineWith({
      [OLD]: [
        {
          condition: {
            responseHeaders: [{ header: 'vary', values: ['origin'] }],
            excludedResponseHeaders: [{ header: 'set-cookie', values: ['b=*'] }]
          }
        }
      ]
    })
    const info = request('https://x.example/')
    const evaluate = (headers: Record<string, string[]>): string | undefined =>
      engine.evaluateHeadersReceived(info, headers, createDnrRequestState()).actions[0]?.type
    expect(evaluate({ Vary: ['Accept, Origin'] })).toBe('block')
    expect(evaluate({ Vary: ['Accept, Origin'], 'Set-Cookie': ['a=1, b=2'] })).toBe('block')
    // Set-Cookie is never split, so 'a=1, b=2' is one value that does not start with b=.
    expect(evaluate({ Vary: ['Origin'], 'Set-Cookie': ['b=1'] })).toBeUndefined()
  })

  it('keeps an earlier-stage allow in force and drops header actions it outranks', () => {
    const engine = engineWith({
      [OLD]: [
        {
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'x-early', operation: 'set', value: '1' }]
          },
          condition: {}
        },
        {
          priority: 3,
          action: { type: 'allow' },
          condition: { responseHeaders: [{ header: 'x-allow' }] }
        },
        {
          priority: 2,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'x-late', operation: 'set', value: '1' }]
          },
          condition: { responseHeaders: [{ header: 'x-late-trigger' }] }
        }
      ]
    })
    const state = createDnrRequestState()
    const info = request('https://x.example/')
    expect(engine.evaluateBeforeRequest(info, state).actions.map((a) => a.rule.ruleId)).toEqual([1])
    const late = engine.evaluateHeadersReceived(
      info,
      { 'x-allow': ['1'], 'x-late-trigger': ['1'] },
      state
    )
    expect(late.actions.map((a) => a.type)).toEqual(['allow'])
    expect(late.reportAllowMatch).toBe(true)
    expect(state.actions).toEqual([])
  })
})
