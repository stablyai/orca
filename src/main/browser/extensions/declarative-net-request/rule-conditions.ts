import { DnrDomainList } from './domain-matching'
import { dnrRuleProblem, isDnrRuleProblem, type DnrRuleProblem } from './parse-errors'
import {
  ELEMENT_TYPE,
  ELEMENT_TYPE_ANY,
  ELEMENT_TYPE_DEFAULT,
  REQUEST_METHOD_ANY,
  resourceTypeBit,
  ruleMethodBit
} from './rule-flags'
import type { DnrRule } from './rule-types'
import { isAsciiText, toLowerAscii } from './url-text'

// Condition parsing steps of IndexedRule::CreateIndexedRule (indexed_rule.cc):
// ComputeRequestMethods, ComputeElementTypes, CanonicalizeDomains and tab ids.

export type DnrRuleConditionFields = {
  elementTypes: number
  requestMethods: number
  initiatorDomains: DnrDomainList | null
  excludedInitiatorDomains: DnrDomainList | null
  requestDomains: DnrDomainList | null
  excludedRequestDomains: DnrDomainList | null
  topDomains: DnrDomainList | null
  excludedTopDomains: DnrDomainList | null
  tabIds: ReadonlySet<number> | null
  excludedTabIds: ReadonlySet<number> | null
}

function bits<T>(values: T[] | undefined, bit: (value: T) => number): number {
  return (values ?? []).reduce((mask, value) => mask | bit(value), 0)
}

/** The empty-list checks CreateIndexedRule runs before anything else in the condition. */
export function emptyConditionListProblem(rule: DnrRule): DnrRuleProblem | null {
  const { condition } = rule
  const lists: [string, unknown[] | undefined][] = [
    ['domains', condition.domains],
    ['initiatorDomains', condition.initiatorDomains],
    ['requestDomains', condition.requestDomains],
    ['topDomains', condition.topDomains],
    ['resourceTypes', condition.resourceTypes],
    ['requestMethods', condition.requestMethods],
    ['tabIds', condition.tabIds]
  ]
  const empty = lists.find(([, list]) => list !== undefined && list.length === 0)
  return empty ? dnrRuleProblem('emptyList', rule.id, empty[0]) : null
}

function requestMethods(rule: DnrRule): number | DnrRuleProblem {
  const included = bits(rule.condition.requestMethods, ruleMethodBit)
  const excluded = bits(rule.condition.excludedRequestMethods, ruleMethodBit)
  if (included & excluded) {
    return dnrRuleProblem('requestMethodDuplicated', rule.id)
  }
  if (included !== 0) {
    return included
  }
  // An exclusion list keeps NON_HTTP, so ws:// and file:// still match.
  return excluded !== 0 ? REQUEST_METHOD_ANY & ~excluded : REQUEST_METHOD_ANY
}

function elementTypes(rule: DnrRule): number | DnrRuleProblem {
  const included = bits(rule.condition.resourceTypes, resourceTypeBit)
  const excluded = bits(rule.condition.excludedResourceTypes, resourceTypeBit)
  if (excluded === (ELEMENT_TYPE_ANY & ~ELEMENT_TYPE.objectSubrequest)) {
    return dnrRuleProblem('noApplicableResourceTypes', rule.id)
  }
  if (included & excluded) {
    return dnrRuleProblem('resourceTypeDuplicated', rule.id)
  }
  if (rule.action.type === 'allowAllRequests') {
    const frames = ELEMENT_TYPE.mainFrame | ELEMENT_TYPE.subDocument
    if (included === 0 || (included | frames) !== frames) {
      return dnrRuleProblem('invalidAllowAllRequestsResourceType', rule.id)
    }
  }
  if (included !== 0) {
    return included
  }
  return excluded !== 0 ? ELEMENT_TYPE_ANY & ~excluded : ELEMENT_TYPE_DEFAULT
}

function domainList(
  rule: DnrRule,
  key: string,
  domains: string[] | undefined
): DnrDomainList | null | DnrRuleProblem {
  if (domains === undefined) {
    return null
  }
  if (!domains.every(isAsciiText)) {
    return dnrRuleProblem('nonAscii', rule.id, key)
  }
  return new DnrDomainList(domains.map(toLowerAscii))
}

export function parseRuleConditionFields(rule: DnrRule): DnrRuleConditionFields | DnrRuleProblem {
  const { condition } = rule
  const methods = requestMethods(rule)
  if (isDnrRuleProblem(methods)) {
    return methods
  }
  const types = elementTypes(rule)
  if (isDnrRuleProblem(types)) {
    return types
  }
  if (condition.domains && condition.initiatorDomains) {
    return dnrRuleProblem('domainsAndInitiatorDomains', rule.id, 'domains', 'initiatorDomains')
  }
  if (condition.excludedDomains && condition.excludedInitiatorDomains) {
    return dnrRuleProblem(
      'excludedDomainsAndExcludedInitiatorDomains',
      rule.id,
      'excludedDomains',
      'excludedInitiatorDomains'
    )
  }
  // The deprecated domains/excludedDomains map onto the initiator lists.
  const keyed: [string, string[] | undefined][] = [
    ['domains', condition.domains],
    ['initiatorDomains', condition.initiatorDomains],
    ['excludedDomains', condition.excludedDomains],
    ['excludedInitiatorDomains', condition.excludedInitiatorDomains],
    ['requestDomains', condition.requestDomains],
    ['excludedRequestDomains', condition.excludedRequestDomains],
    ['topDomains', condition.topDomains],
    ['excludedTopDomains', condition.excludedTopDomains]
  ]
  const lists = new Map<string, DnrDomainList | null>()
  for (const [key, domains] of keyed) {
    const list = domainList(rule, key, domains)
    if (isDnrRuleProblem(list)) {
      return list
    }
    lists.set(key, list)
  }
  const list = (key: string): DnrDomainList | null => lists.get(key) ?? null
  const tabIds = condition.tabIds ? new Set(condition.tabIds) : null
  if (tabIds && condition.excludedTabIds?.some((id) => tabIds.has(id))) {
    return dnrRuleProblem('tabIdDuplicated', rule.id)
  }
  return {
    elementTypes: types,
    requestMethods: methods,
    initiatorDomains: list('domains') ?? list('initiatorDomains'),
    excludedInitiatorDomains: list('excludedDomains') ?? list('excludedInitiatorDomains'),
    requestDomains: list('requestDomains'),
    excludedRequestDomains: list('excludedRequestDomains'),
    topDomains: list('topDomains'),
    excludedTopDomains: list('excludedTopDomains'),
    tabIds,
    // When both lists are present only the included tab ids matter.
    excludedTabIds:
      tabIds === null && condition.excludedTabIds ? new Set(condition.excludedTabIds) : null
  }
}
