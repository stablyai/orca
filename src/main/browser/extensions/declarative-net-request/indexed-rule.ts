import {
  parseHeaderModifications,
  parseResponseHeaderConditions,
  type DnrHeaderCondition,
  type DnrHeaderModification
} from './header-rules'
import { dnrRuleProblem, isDnrRuleProblem, type DnrRuleProblem } from './parse-errors'
import { parseDnrRedirect, type DnrRedirectSpec } from './redirect-url'
import { isValidRegexSubstitution, translateDnrRegex } from './regex-filter'
import {
  emptyConditionListProblem,
  parseRuleConditionFields,
  type DnrRuleConditionFields
} from './rule-conditions'
import { indexedRulePriority } from './rule-flags'
import type { DnrActionType, DnrRule } from './rule-types'
import { DnrUrlPatternMatcher, parseUrlFilter } from './url-pattern'
import { isAsciiText, toLowerAscii } from './url-text'

// IndexedRule::CreateIndexedRule (indexed_rule.cc). Checks run in Chromium's order so the
// first problem reported is the one Chrome would report.

export type DnrCompiledRegex = {
  regex: RegExp
  substitution: string | null
  /** Lower-cased literal that every match contains; '' when there is none. */
  requiredLiteral: string
}

export type DnrIndexedRule = DnrRuleConditionFields & {
  id: number
  priority: number
  /** (priority << 8) | action-type priority, Chromium's tie-break inside one extension. */
  indexPriority: number
  action: DnrActionType
  /** Rules with response-header conditions only match once headers arrive. */
  stage: 'beforeRequest' | 'headersReceived'
  urlPattern: DnrUrlPatternMatcher | null
  regex: DnrCompiledRegex | null
  firstParty: boolean
  thirdParty: boolean
  responseHeaders: DnrHeaderCondition[] | null
  excludedResponseHeaders: DnrHeaderCondition[] | null
  redirect: DnrRedirectSpec | null
  requestHeaders: DnrHeaderModification[]
  responseHeadersToModify: DnrHeaderModification[]
}

export type DnrRuleContext = { extensionId: string; isSessionRuleset: boolean }

type RegexStep = { compiled: DnrCompiledRegex | null } | DnrRuleProblem

/** ValidateRegex, keeping the compiled pattern. */
function regexStep(rule: DnrRule, redirect: DnrRedirectSpec | null): RegexStep {
  const { regexFilter } = rule.condition
  const substitution = redirect?.kind === 'regexSubstitution' ? redirect.substitution : null
  if (regexFilter === undefined) {
    return substitution === null
      ? { compiled: null }
      : dnrRuleProblem(
          'regexSubstitutionWithoutFilter',
          rule.id,
          'regexSubstitution',
          'regexFilter'
        )
  }
  if (regexFilter === '') {
    return dnrRuleProblem('emptyRegexFilter', rule.id, 'regexFilter')
  }
  if (!isAsciiText(regexFilter)) {
    return dnrRuleProblem('nonAscii', rule.id, 'regexFilter')
  }
  const caseSensitive = rule.condition.isUrlFilterCaseSensitive === true
  const options = { caseSensitive, requireCapturing: substitution !== null }
  const check = translateDnrRegex(regexFilter, options)
  if (!check.ok) {
    return check.reason === 'memoryLimitExceeded'
      ? dnrRuleProblem('regexTooLarge', rule.id, 'regexFilter')
      : dnrRuleProblem('invalidRegexFilter', rule.id, 'regexFilter')
  }
  if (substitution !== null && !isValidRegexSubstitution(substitution, check.captureCount)) {
    return dnrRuleProblem('invalidRegexSubstitution', rule.id, 'action.redirect.regexSubstitution')
  }
  return { compiled: { regex: check.regex, substitution, requiredLiteral: check.requiredLiteral } }
}

function urlFilterProblem(rule: DnrRule): DnrRuleProblem | null {
  const { urlFilter } = rule.condition
  if (urlFilter === '') {
    return dnrRuleProblem('emptyUrlFilter', rule.id, 'urlFilter')
  }
  return urlFilter !== undefined && !isAsciiText(urlFilter)
    ? dnrRuleProblem('nonAscii', rule.id, 'urlFilter')
    : null
}

function urlPatternStep(rule: DnrRule): DnrUrlPatternMatcher | null | DnrRuleProblem {
  if (rule.condition.regexFilter !== undefined) {
    return null
  }
  const parsed = parseUrlFilter(rule.condition.urlFilter ?? '')
  // url_pattern_index cannot match "||*xyz".
  if (parsed.anchorLeft === 'subdomain' && parsed.pattern.startsWith('*')) {
    return dnrRuleProblem('invalidUrlFilter', rule.id, 'urlFilter')
  }
  const matchCase = rule.condition.isUrlFilterCaseSensitive === true
  const pattern = matchCase ? parsed.pattern : toLowerAscii(parsed.pattern)
  return new DnrUrlPatternMatcher({ ...parsed, pattern, matchCase })
}

function responseHeaderStep(
  rule: DnrRule
): Pick<DnrIndexedRule, 'responseHeaders' | 'excludedResponseHeaders'> | DnrRuleProblem {
  const { responseHeaders, excludedResponseHeaders } = rule.condition
  if (responseHeaders !== undefined && responseHeaders.length === 0) {
    return dnrRuleProblem('emptyList', rule.id, 'condition.responseHeaders')
  }
  if (excludedResponseHeaders !== undefined && excludedResponseHeaders.length === 0) {
    return dnrRuleProblem('emptyList', rule.id, 'condition.excludedResponseHeaders')
  }
  const parsed = parseResponseHeaderConditions(
    responseHeaders ?? [],
    excludedResponseHeaders ?? [],
    rule.id
  )
  if (isDnrRuleProblem(parsed)) {
    return parsed
  }
  return {
    responseHeaders: responseHeaders === undefined ? null : parsed.included,
    excludedResponseHeaders: excludedResponseHeaders === undefined ? null : parsed.excluded
  }
}

type HeaderActions = Pick<DnrIndexedRule, 'requestHeaders' | 'responseHeadersToModify'>

function modifyHeadersStep(
  rule: DnrRule,
  matchesResponseHeaders: boolean
): HeaderActions | DnrRuleProblem {
  const empty: HeaderActions = { requestHeaders: [], responseHeadersToModify: [] }
  if (rule.action.type !== 'modifyHeaders') {
    return empty
  }
  const { requestHeaders, responseHeaders } = rule.action
  if (!requestHeaders && !responseHeaders) {
    return dnrRuleProblem(
      'noHeadersToModifySpecified',
      rule.id,
      'action.requestHeaders',
      'action.responseHeaders'
    )
  }
  if (requestHeaders) {
    if (matchesResponseHeaders) {
      return dnrRuleProblem('responseHeaderRuleCannotModifyRequestHeaders', rule.id)
    }
    const parsed = parseHeaderModifications(requestHeaders, true, rule.id)
    if (isDnrRuleProblem(parsed)) {
      return parsed
    }
    empty.requestHeaders = parsed
  }
  if (responseHeaders) {
    const parsed = parseHeaderModifications(responseHeaders, false, rule.id)
    if (isDnrRuleProblem(parsed)) {
      return parsed
    }
    empty.responseHeadersToModify = parsed
  }
  return empty
}

export function createIndexedRule(
  rule: DnrRule,
  context: DnrRuleContext
): { ok: true; rule: DnrIndexedRule } | { ok: false; problem: DnrRuleProblem } {
  const fail = (problem: DnrRuleProblem): { ok: false; problem: DnrRuleProblem } => ({
    ok: false,
    problem
  })
  if (rule.id < 1) {
    return fail(dnrRuleProblem('invalidRuleId', rule.id, 'id', '1'))
  }
  const priority = rule.priority ?? 1
  if (priority < 1) {
    return fail(dnrRuleProblem('invalidRulePriority', rule.id, 'priority', '1'))
  }
  let redirect: DnrRedirectSpec | null = null
  if (rule.action.type === 'redirect') {
    const parsed = rule.action.redirect
      ? parseDnrRedirect(rule.action.redirect, rule.id, context.extensionId)
      : dnrRuleProblem('invalidRedirect', rule.id, 'action.redirect')
    if (isDnrRuleProblem(parsed)) {
      return fail(parsed)
    }
    redirect = parsed
  }
  const { condition } = rule
  const emptyList = emptyConditionListProblem(rule)
  if (emptyList) {
    return fail(emptyList)
  }
  if (!context.isSessionRuleset && (condition.tabIds || condition.excludedTabIds)) {
    return fail(dnrRuleProblem('tabIdsOnNonSessionRule', rule.id, 'tabIds', 'excludedTabIds'))
  }
  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) {
    return fail(dnrRuleProblem('multipleFiltersSpecified', rule.id, 'urlFilter', 'regexFilter'))
  }
  const regex = regexStep(rule, redirect)
  if (isDnrRuleProblem(regex)) {
    return fail(regex)
  }
  const filterProblem = urlFilterProblem(rule)
  if (filterProblem) {
    return fail(filterProblem)
  }
  const fields = parseRuleConditionFields(rule)
  if (isDnrRuleProblem(fields)) {
    return fail(fields)
  }
  const headerConditions = responseHeaderStep(rule)
  if (isDnrRuleProblem(headerConditions)) {
    return fail(headerConditions)
  }
  const urlPattern = urlPatternStep(rule)
  if (isDnrRuleProblem(urlPattern)) {
    return fail(urlPattern)
  }
  const matchesResponseHeaders =
    headerConditions.responseHeaders !== null || headerConditions.excludedResponseHeaders !== null
  const headerActions = modifyHeadersStep(rule, matchesResponseHeaders)
  if (isDnrRuleProblem(headerActions)) {
    return fail(headerActions)
  }
  return {
    ok: true,
    rule: {
      ...fields,
      ...headerConditions,
      ...headerActions,
      id: rule.id,
      priority,
      indexPriority: indexedRulePriority(priority, rule.action.type),
      action: rule.action.type,
      stage: matchesResponseHeaders ? 'headersReceived' : 'beforeRequest',
      urlPattern,
      regex: regex.compiled,
      firstParty: condition.domainType !== 'thirdParty',
      thirdParty: condition.domainType !== 'firstParty',
      redirect
    }
  }
}
