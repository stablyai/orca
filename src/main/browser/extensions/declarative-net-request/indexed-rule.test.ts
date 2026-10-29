import { describe, expect, it } from 'vitest'
import { createIndexedRule, type DnrIndexedRule } from './indexed-rule'
import {
  ELEMENT_TYPE,
  ELEMENT_TYPE_DEFAULT,
  REQUEST_METHOD,
  REQUEST_METHOD_ANY
} from './rule-flags'
import type { DnrRule } from './rule-types'
import { buildDnrRuleset } from './ruleset-builder'

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'

function rule(overrides: Partial<DnrRule> & Pick<DnrRule, 'condition'>): DnrRule {
  return { id: 1, action: { type: 'block' }, ...overrides }
}

function parse(input: DnrRule, isSessionRuleset = false): DnrIndexedRule | string {
  const result = createIndexedRule(input, { extensionId: EXTENSION_ID, isSessionRuleset })
  return result.ok ? result.rule : result.problem.message
}

function parsed(input: DnrRule, isSessionRuleset = false): DnrIndexedRule {
  const result = parse(input, isSessionRuleset)
  if (typeof result === 'string') {
    throw new Error(result)
  }
  return result
}

describe('createIndexedRule defaults', () => {
  it('applies Chrome defaults: priority 1, every type but main_frame, any method, both parties', () => {
    const indexed = parsed(rule({ condition: { urlFilter: 'ads' } }))
    expect(indexed.priority).toBe(1)
    expect(indexed.indexPriority).toBe(256 + 3)
    expect(indexed.elementTypes).toBe(ELEMENT_TYPE_DEFAULT)
    expect(indexed.elementTypes & ELEMENT_TYPE.mainFrame).toBe(0)
    expect(indexed.requestMethods).toBe(REQUEST_METHOD_ANY)
    expect(indexed.firstParty && indexed.thirdParty).toBe(true)
    expect(indexed.stage).toBe('beforeRequest')
  })

  it('folds the action type into the index priority (allow > allowAllRequests > block > upgrade > redirect)', () => {
    const priorityOf = (type: DnrRule['action']['type']): number =>
      parsed(
        rule({
          action: {
            type,
            redirect: { url: 'https://e.com/' },
            requestHeaders: [{ header: 'a', operation: 'remove' }]
          },
          condition: { resourceTypes: ['main_frame'] }
        })
      ).indexPriority
    const order = [
      'allow',
      'allowAllRequests',
      'block',
      'upgradeScheme',
      'redirect',
      'modifyHeaders'
    ] as const
    const priorities = order.map(priorityOf)
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities)
  })

  it('lower-cases case-insensitive url filters only', () => {
    expect(
      parsed(rule({ condition: { urlFilter: '||ADS.Example^' } })).urlPattern?.filter.pattern
    ).toBe('ads.example^')
    const sensitive = parsed(
      rule({ condition: { urlFilter: '/Ads/', isUrlFilterCaseSensitive: true } })
    )
    expect(sensitive.urlPattern?.filter.pattern).toBe('/Ads/')
  })

  it('excluded types and methods subtract from everything (NON_HTTP stays)', () => {
    const indexed = parsed(
      rule({ condition: { excludedResourceTypes: ['image'], excludedRequestMethods: ['post'] } })
    )
    expect(indexed.elementTypes & ELEMENT_TYPE.mainFrame).not.toBe(0)
    expect(indexed.elementTypes & ELEMENT_TYPE.image).toBe(0)
    expect(indexed.requestMethods & REQUEST_METHOD.nonHttp).not.toBe(0)
    expect(indexed.requestMethods & REQUEST_METHOD.post).toBe(0)
    expect(parsed(rule({ condition: { requestMethods: ['get'] } })).requestMethods).toBe(
      REQUEST_METHOD.get
    )
  })

  it('sorts domains longest first and maps the deprecated keys onto initiator lists', () => {
    const indexed = parsed(
      rule({
        condition: {
          domains: ['a.com', 'b.com', 'a.com'],
          excludedDomains: ['g.com', 'XY.COM', 'zzz.com', 'a.com', 'google.com']
        }
      })
    )
    expect(indexed.initiatorDomains?.domains).toEqual(['a.com', 'a.com', 'b.com'])
    expect(indexed.excludedInitiatorDomains?.domains).toEqual([
      'google.com',
      'zzz.com',
      'xy.com',
      'a.com',
      'g.com'
    ])
  })

  it('keeps only included tab ids when both lists are given', () => {
    const indexed = parsed(rule({ condition: { tabIds: [1, 2], excludedTabIds: [3] } }), true)
    expect([...(indexed.tabIds ?? [])]).toEqual([1, 2])
    expect(indexed.excludedTabIds).toBeNull()
  })

  it('moves rules with response-header conditions to the headers-received stage', () => {
    const indexed = parsed(
      rule({ condition: { responseHeaders: [{ header: 'Content-Type', values: ['TEXT/*'] }] } })
    )
    expect(indexed.stage).toBe('headersReceived')
    expect(indexed.responseHeaders).toEqual([
      { header: 'content-type', values: ['text/*'], excludedValues: null }
    ])
  })

  it('compiles regexes as written, case-insensitive by default', () => {
    const indexed = parsed(rule({ condition: { regexFilter: '^https://\\S+/ADS$' } }))
    expect(indexed.regex?.regex.test('https://example.com/ads')).toBe(true)
    expect(indexed.regex?.requiredLiteral).toBe('https://')
  })
})

describe('createIndexedRule errors (Chromium messages)', () => {
  it.each<[string, DnrRule, string]>([
    [
      'id',
      rule({ id: 0, condition: {} }),
      'Rule with id 0 has an invalid value for id key. This should be greater than or equal to 1.'
    ],
    [
      'priority',
      rule({ priority: 0, condition: {} }),
      'Rule with id 1 has an invalid value for priority key. This should be greater than or equal to 1.'
    ],
    [
      'empty urlFilter',
      rule({ condition: { urlFilter: '' } }),
      'Rule with id 1 cannot have an empty value for urlFilter key.'
    ],
    [
      'non-ascii urlFilter',
      rule({ condition: { urlFilter: 'ⱴase.com' } }),
      'Rule with id 1 cannot have non-ascii characters as part of "urlFilter" key.'
    ],
    [
      '||*',
      rule({ condition: { urlFilter: '||*xyz' } }),
      'Rule with id 1 specifies an incorrect value for the "urlFilter" key.'
    ],
    [
      'both filters',
      rule({ condition: { urlFilter: 'a', regexFilter: 'b' } }),
      'Rule with id 1 can only specify one of "urlFilter" or "regexFilter" keys.'
    ],
    [
      'empty domains',
      rule({ condition: { initiatorDomains: [] } }),
      'Rule with id 1 cannot have an empty list as the value for initiatorDomains key.'
    ],
    [
      'non-ascii domain',
      rule({ condition: { requestDomains: ['36°c.com'] } }),
      'Rule with id 1 cannot have non-ascii characters as part of "requestDomains" key.'
    ],
    [
      'domains + initiatorDomains',
      rule({ condition: { domains: ['a.com'], initiatorDomains: ['b.com'] } }),
      'Rule with id 1 cannot use deprecated field "domains". Use "initiatorDomains" instead.'
    ],
    [
      'type in both lists',
      rule({ condition: { resourceTypes: ['image'], excludedResourceTypes: ['image'] } }),
      'Rule with id 1 includes and excludes the same resource.'
    ],
    [
      'no types left',
      rule({
        condition: {
          excludedResourceTypes: [
            'main_frame',
            'sub_frame',
            'stylesheet',
            'script',
            'image',
            'font',
            'object',
            'xmlhttprequest',
            'ping',
            'csp_report',
            'media',
            'websocket',
            'webtransport',
            'webbundle',
            'other'
          ]
        }
      }),
      'Rule with id 1 is not applicable to any resource type.'
    ],
    [
      'method in both lists',
      rule({ condition: { requestMethods: ['get'], excludedRequestMethods: ['get'] } }),
      'Rule with id 1 includes and excludes the same request method.'
    ],
    [
      'allowAllRequests types',
      rule({ action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['script'] } }),
      'Rule with id 1 is an "allowAllRequests" rule and must specify the "resourceTypes" key. It may only include the "main_frame" and "sub_frame" resource types.'
    ],
    [
      'tabIds on static',
      rule({ condition: { tabIds: [1] } }),
      'Rule with id 1 specifies a value for "tabIds" or "excludedTabIds" key. These are only supported for session-scoped rules.'
    ],
    [
      'redirect without redirect',
      rule({ action: { type: 'redirect' }, condition: {} }),
      'Rule with id 1 specifies an incorrect value for the "action.redirect" key.'
    ],
    [
      'bad redirect url',
      rule({ action: { type: 'redirect', redirect: { url: 'xyz' } }, condition: {} }),
      'Rule with id 1 does not provide a valid URL for action.redirect.url key.'
    ],
    [
      'javascript redirect',
      rule({
        action: { type: 'redirect', redirect: { url: 'javascript:alert(1)' } },
        condition: {}
      }),
      'Rule with id 1 specifies an incorrect value for the "action.redirect.url" key. Redirects to javascript urls are not supported.'
    ],
    [
      'relative extensionPath',
      rule({
        action: { type: 'redirect', redirect: { extensionPath: 'foo/xyz/' } },
        condition: {}
      }),
      'Rule with id 1 specifies an incorrect value for the "action.redirect.extensionPath" key.'
    ],
    [
      'transform scheme',
      rule({
        action: { type: 'redirect', redirect: { transform: { scheme: 'javascript' } } },
        condition: {}
      }),
      'Rule with id 1 specifies an incorrect value for the "action.redirect.transform.scheme" key. Allowed values are: [http, https, ftp, chrome-extension].'
    ],
    [
      'transform port',
      rule({
        action: { type: 'redirect', redirect: { transform: { port: '-1' } } },
        condition: {}
      }),
      'Rule with id 1 specifies an incorrect value for the "action.redirect.transform.port" key.'
    ],
    [
      'transform query',
      rule({
        action: { type: 'redirect', redirect: { transform: { query: 'abc' } } },
        condition: {}
      }),
      'Rule with id 1 specifies an incorrect value for the "action.redirect.transform.query" key.'
    ],
    [
      'query + queryTransform',
      rule({
        action: {
          type: 'redirect',
          redirect: { transform: { query: '?a', queryTransform: { removeParams: ['a'] } } }
        },
        condition: {}
      }),
      'Rule with id 1 cannot specify both "action.redirect.transform.query" and "action.redirect.transform.queryTransform" keys.'
    ],
    [
      'substitution without regex',
      rule({
        action: { type: 'redirect', redirect: { regexSubstitution: '\\0' } },
        condition: { urlFilter: 'a' }
      }),
      'Rule with id 1 can\'t specify the "regexSubstitution" key without specifying the "regexFilter" key.'
    ],
    [
      'bad substitution',
      rule({
        action: { type: 'redirect', redirect: { regexSubstitution: '\\1' } },
        condition: { regexFilter: 'abc' }
      }),
      'Rule with id 1 specifies an incorrect value for the "action.redirect.regexSubstitution" key.'
    ],
    [
      'invalid regex',
      rule({ condition: { regexFilter: 'a(?=b)' } }),
      'Rule with id 1 specifies an incorrect value for the "regexFilter" key.'
    ],
    [
      'large regex',
      rule({ condition: { regexFilter: '[a-z0-9]{38}' } }),
      'Rule with id 1 was skipped as the "regexFilter" value exceeded the 2KB memory limit when compiled. Learn more: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#regex-rules'
    ],
    [
      'no headers',
      rule({ action: { type: 'modifyHeaders' }, condition: {} }),
      'Rule with id 1 does not specify a value for "action.requestHeaders" or "action.responseHeaders" key. At least one of these keys must be specified with a non-empty list.'
    ],
    [
      'append to non-list header',
      rule({
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'append', value: 'x' }]
        },
        condition: {}
      }),
      'Rule with id 1 specifies an invalid request header to be appended. Only standard HTTP request headers that can specify multiple values for a single entry are supported.'
    ],
    [
      'remove with value',
      rule({
        action: {
          type: 'modifyHeaders',
          responseHeaders: [{ header: 'a', operation: 'remove', value: 'x' }]
        },
        condition: {}
      }),
      'Rule with id 1 must not provide a header value for a header to be removed.'
    ],
    [
      'set without value',
      rule({
        action: { type: 'modifyHeaders', responseHeaders: [{ header: 'a', operation: 'set' }] },
        condition: {}
      }),
      'Rule with id 1 must provide a value for a header to be appended/set.'
    ],
    [
      'bad header name',
      rule({
        action: {
          type: 'modifyHeaders',
          responseHeaders: [{ header: 'a b', operation: 'remove' }]
        },
        condition: {}
      }),
      'Rule with id 1 must specify a valid header name to be modified.'
    ],
    [
      'response-header rule modifying requests',
      rule({
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'a', operation: 'remove' }] },
        condition: { responseHeaders: [{ header: 'x' }] }
      }),
      'Rule with id 1 which matches on response headers cannot modify request headers.'
    ],
    [
      'header in both condition lists',
      rule({
        condition: {
          responseHeaders: [{ header: 'x' }],
          excludedResponseHeaders: [{ header: 'x' }]
        }
      }),
      'Rule with id 1 includes and excludes the same response header.'
    ]
  ])('%s', (_name, input, message) => {
    expect(parse(input)).toBe(message)
  })

  it('reports the first problem in Chromium order', () => {
    // A bad priority is reported before the empty url filter.
    expect(parse(rule({ priority: 0, condition: { urlFilter: '' } }))).toContain('priority')
  })
})

describe('buildDnrRuleset', () => {
  const good = { id: 1, condition: { urlFilter: 'ads' }, action: { type: 'block' } }
  it('skips invalid static rules with warnings', () => {
    const result = buildDnrRuleset(
      [good, { ...good }, { id: 2, condition: {}, action: { type: 'bogus' } }],
      {
        extensionId: EXTENSION_ID,
        source: { kind: 'static', id: 'rs', manifestIndex: 0 },
        invalidRules: 'warn'
      }
    )
    expect(result.ok && result.ruleCount).toBe(1)
    expect(result.ok && result.warnings.map((warning) => warning.message)).toEqual([
      'Rule with id 1 does not have a unique ID.',
      "Rule at index 2 couldn't be parsed. Parse error: Error at key 'action': Error at key 'type': Value must be one of block, redirect, allow, upgradeScheme, modifyHeaders, allowAllRequests."
    ])
  })

  it('rejects a dynamic update on the first invalid rule', () => {
    const result = buildDnrRuleset(
      [good, { id: 2, condition: { urlFilter: '' }, action: { type: 'block' } }],
      {
        extensionId: EXTENSION_ID,
        source: { kind: 'dynamic' },
        invalidRules: 'error'
      }
    )
    expect(result).toMatchObject({ ok: false, error: { error: 'emptyUrlFilter', ruleId: 2 } })
  })
})
