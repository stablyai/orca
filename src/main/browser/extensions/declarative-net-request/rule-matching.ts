import { hostMatchesDomainLists } from './domain-matching'
import type { DnrHeaderCondition } from './header-rules'
import type { DnrIndexedRule } from './indexed-rule'
import type { DnrRequestContext } from './request-context'

// Per-rule checks from url_pattern_index.cc (DoesRuleFlagsMatch, DoesOriginMatchInitiatorDomainList,
// DoesURLMatchRequestDomainList) and request_params.cc DoEmbedderConditionsMatch.

/** base::MatchPattern: '*' is any run, '?' is zero or one character, '\' escapes. */
function matchPattern(text: string, pattern: string): boolean {
  let previous = new Uint8Array(pattern.length + 1)
  let current = new Uint8Array(pattern.length + 1)
  previous[0] = 1
  for (let p = 0; p < pattern.length && (pattern[p] === '*' || pattern[p] === '?'); p++) {
    previous[p + 1] = 1
  }
  for (let t = 0; t < text.length; t++) {
    current.fill(0)
    for (let p = 0; p < pattern.length; p++) {
      if (pattern[p] === '*') {
        current[p + 1] = current[p] || previous[p + 1]
      } else if (pattern[p] === '?') {
        current[p + 1] = current[p] || previous[p]
      } else {
        const escaped = pattern[p] === '\\' && p + 1 < pattern.length
        const want = escaped ? pattern[p + 1] : pattern[p]
        const next = p + (escaped ? 2 : 1)
        current[next] = previous[p] && text[t] === want ? 1 : 0
        p = next - 1
      }
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[pattern.length] === 1
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
