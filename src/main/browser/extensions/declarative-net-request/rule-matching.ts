import { hostMatchesDomainLists } from './domain-matching'
import type { DnrHeaderCondition } from './header-rules'
import type { DnrIndexedRule } from './indexed-rule'
import type { DnrRequestContext } from './request-context'

// Per-rule checks from url_pattern_index.cc (DoesRuleFlagsMatch, DoesOriginMatchInitiatorDomainList,
// DoesURLMatchRequestDomainList) and request_params.cc DoEmbedderConditionsMatch.

/** base::MatchPattern: '*' is any run, '?' is zero or one character, '\' escapes. */
function matchPattern(text: string, pattern: string): boolean {
  const memo = new Map<number, boolean>()
  const match = (t: number, p: number): boolean => {
    const key = t * (pattern.length + 1) + p
    const cached = memo.get(key)
    if (cached !== undefined) {
      return cached
    }
    let result: boolean
    if (p === pattern.length) {
      result = t === text.length
    } else if (pattern[p] === '*') {
      result = match(t, p + 1) || (t < text.length && match(t + 1, p))
    } else if (pattern[p] === '?') {
      result = match(t, p + 1) || (t < text.length && match(t + 1, p + 1))
    } else {
      const escaped = pattern[p] === '\\' && p + 1 < pattern.length
      const want = escaped ? pattern[p + 1] : pattern[p]
      result = t < text.length && text[t] === want && match(t + 1, p + (escaped ? 2 : 1))
    }
    memo.set(key, result)
    return result
  }
  return match(0, 0)
}

/** MatchesHeaderConditions: true when any condition is met. */
function matchesHeaderConditions(
  headers: ReadonlyMap<string, string[]>,
  conditions: readonly DnrHeaderCondition[]
): boolean {
  for (const condition of conditions) {
    const values = headers.get(condition.header)
    if (values === undefined) {
      continue
    }
    if (condition.values === null && condition.excludedValues === null) {
      return true
    }
    const hasValue = (pattern: string): boolean =>
      values.some((value) => matchPattern(value, pattern))
    if (condition.excludedValues?.some(hasValue)) {
      continue
    }
    if (condition.values === null || condition.values.some(hasValue)) {
      return true
    }
  }
  return false
}

/** Flags plus embedder conditions (tab ids, top domains, response headers). */
function flagsMatch(rule: DnrIndexedRule, context: DnrRequestContext): boolean {
  if (
    (rule.elementTypes & context.elementType) === 0 ||
    (rule.requestMethods & context.method) === 0
  ) {
    return false
  }
  if (context.isThirdParty ? !rule.thirdParty : !rule.firstParty) {
    return false
  }
  if (rule.tabIds !== null && !rule.tabIds.has(context.tabId)) {
    return false
  }
  if (rule.excludedTabIds !== null && rule.excludedTabIds.has(context.tabId)) {
    return false
  }
  if (
    (rule.topDomains !== null || rule.excludedTopDomains !== null) &&
    !hostMatchesDomainLists(
      context.topHost,
      context.topHostSuffixes,
      rule.topDomains,
      rule.excludedTopDomains
    )
  ) {
    return false
  }
  const headers = context.responseHeaders
  if (headers !== null) {
    if (
      rule.excludedResponseHeaders !== null &&
      matchesHeaderConditions(headers, rule.excludedResponseHeaders)
    ) {
      return false
    }
    if (rule.responseHeaders !== null && !matchesHeaderConditions(headers, rule.responseHeaders)) {
      return false
    }
  }
  return true
}

function domainsMatch(rule: DnrIndexedRule, context: DnrRequestContext): boolean {
  if (context.initiatorHost === null) {
    // An opaque initiator only satisfies rules without an included initiator list.
    if (rule.initiatorDomains !== null) {
      return false
    }
  } else if (
    !hostMatchesDomainLists(
      context.initiatorHost,
      context.initiatorHostSuffixes,
      rule.initiatorDomains,
      rule.excludedInitiatorDomains
    )
  ) {
    return false
  }
  return hostMatchesDomainLists(
    context.requestHost,
    context.requestHostSuffixes,
    rule.requestDomains,
    rule.excludedRequestDomains
  )
}

/** Everything but the regex itself: RegexRulesMatcher's DoesRuleMetadataMatchRequest. */
export function regexRuleMetadataMatches(
  rule: DnrIndexedRule,
  context: DnrRequestContext
): boolean {
  return flagsMatch(rule, context) && domainsMatch(rule, context)
}

/** FindMatchAmongCandidates for url-filter rules. */
export function urlRuleMatches(
  rule: DnrIndexedRule,
  context: DnrRequestContext,
  disabledRuleIds: ReadonlySet<number>
): boolean {
  return (
    flagsMatch(rule, context) &&
    rule.urlPattern !== null &&
    rule.urlPattern.matches(context.url) &&
    domainsMatch(rule, context) &&
    !disabledRuleIds.has(rule.id)
  )
}
