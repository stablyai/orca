import type { DnrRule } from './declarative-net-request/rule-types'

/** chrome.declarativeNetRequest constants (declarative_net_request.webidl, Chromium 150). */
export const DNR_API_CONSTANTS = {
  GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
  MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
  MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
  MAX_NUMBER_OF_SESSION_RULES: 5000,
  MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
  GETMATCHEDRULES_QUOTA_INTERVAL: 10,
  MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
  MAX_NUMBER_OF_REGEX_RULES: 1000,
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50
} as const

/** kMaxStaticRulesPerProfile: the pool shared by every extension above its guaranteed minimum. */
export const DNR_GLOBAL_STATIC_RULE_LIMIT = 300_000
/** kMaxDisabledStaticRules. */
export const DNR_MAX_DISABLED_STATIC_RULES = 5000

/** Error text from declarative_net_request/constants.cc. */
export const DNR_ERRORS = {
  dynamicRuleCount: 'Dynamic rule count exceeded.',
  dynamicUnsafeRuleCount: 'Dynamic unsafe rule count exceeded.',
  dynamicRegexRuleCount: 'Dynamic rule count for regex rules exceeded.',
  sessionRuleCount: 'Session rule count exceeded.',
  sessionUnsafeRuleCount: 'Session unsafe rule count exceeded.',
  sessionRegexRuleCount: 'Session rule count for regex rules exceeded.',
  invalidRulesetId: (id: string) => `Invalid ruleset id: ${id}.`,
  enabledRulesetsRuleCount: 'The set of enabled rulesets exceeds the rule count limit.',
  enabledRulesetsRegexRuleCount:
    'The set of enabled rulesets exceeds the regular expression rule count limit.',
  enabledRulesetCount:
    'The number of enabled static rulesets exceeds the enabled ruleset count limit.',
  internal: 'Internal error.',
  disabledStaticRuleCount:
    'The number of disabled static rules exceeds the disabled rule count limit.',
  tabNotFound: (tabId: number) => `No tab with id: ${tabId}.`,
  incrementWithoutBadgeText:
    'Cannot increment action count unless displaying action count as badge text.',
  invalidTestUrl: 'Invalid test request URL.',
  invalidTestInitiator: 'Invalid test request initiator.',
  invalidTestTabId: 'Invalid test request tab ID.',
  invalidTestTopUrl: 'Invalid test request top URL.',
  getMatchedRulesPermission:
    'The extension must have the declarativeNetRequestFeedback permission or have activeTab granted for the specified tab ID in order to call this function.'
} as const

/** IsRuleSafe: only these actions count toward the larger dynamic and session limits. */
export function isSafeDnrRule(rule: Pick<DnrRule, 'action'>): boolean {
  const { type } = rule.action
  return (
    type === 'block' || type === 'allow' || type === 'allowAllRequests' || type === 'upgradeScheme'
  )
}

export type DnrRuleScope = 'dynamic' | 'session'

/** The first limit a dynamic or session rule set breaks, as Chrome reports it, else null. */
export function dnrRuleLimitError(
  scope: DnrRuleScope,
  rules: readonly DnrRule[],
  regexRuleCount: number
): string | null {
  const dynamic = scope === 'dynamic'
  const limit = dynamic
    ? DNR_API_CONSTANTS.MAX_NUMBER_OF_DYNAMIC_RULES
    : DNR_API_CONSTANTS.MAX_NUMBER_OF_SESSION_RULES
  const unsafeLimit = dynamic
    ? DNR_API_CONSTANTS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES
    : DNR_API_CONSTANTS.MAX_NUMBER_OF_UNSAFE_SESSION_RULES
  if (rules.length > limit) {
    return dynamic ? DNR_ERRORS.dynamicRuleCount : DNR_ERRORS.sessionRuleCount
  }
  if (rules.filter((rule) => !isSafeDnrRule(rule)).length > unsafeLimit) {
    return dynamic ? DNR_ERRORS.dynamicUnsafeRuleCount : DNR_ERRORS.sessionUnsafeRuleCount
  }
  if (regexRuleCount > DNR_API_CONSTANTS.MAX_NUMBER_OF_REGEX_RULES) {
    return dynamic ? DNR_ERRORS.dynamicRegexRuleCount : DNR_ERRORS.sessionRegexRuleCount
  }
  return null
}
