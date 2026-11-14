// ParseResult codes and their user-facing text, from
// extensions/browser/api/declarative_net_request/{constants.cc,utils.cc GetParseError}.

export type DnrParseError =
  | 'requestMethodDuplicated'
  | 'resourceTypeDuplicated'
  | 'invalidRuleId'
  | 'invalidRulePriority'
  | 'noApplicableResourceTypes'
  | 'emptyList'
  | 'domainsAndInitiatorDomains'
  | 'excludedDomainsAndExcludedInitiatorDomains'
  | 'emptyUrlFilter'
  | 'invalidRedirectUrl'
  | 'duplicateIds'
  | 'nonAscii'
  | 'invalidUrlFilter'
  | 'invalidRedirect'
  | 'invalidExtensionPath'
  | 'invalidTransformScheme'
  | 'invalidTransformPort'
  | 'invalidTransformQuery'
  | 'invalidTransformFragment'
  | 'queryAndTransformBothSpecified'
  | 'javascriptRedirect'
  | 'emptyRegexFilter'
  | 'invalidRegexFilter'
  | 'regexTooLarge'
  | 'multipleFiltersSpecified'
  | 'regexSubstitutionWithoutFilter'
  | 'invalidRegexSubstitution'
  | 'invalidAllowAllRequestsResourceType'
  | 'noHeadersToModifySpecified'
  | 'invalidHeaderToModifyName'
  | 'invalidHeaderToModifyValue'
  | 'headerValueNotSpecified'
  | 'headerValuePresent'
  | 'appendInvalidRequestHeader'
  | 'tabIdsOnNonSessionRule'
  | 'tabIdDuplicated'
  | 'invalidMatchingResponseHeaderName'
  | 'invalidMatchingResponseHeaderValue'
  | 'matchingResponseHeaderDuplicated'
  | 'responseHeaderRuleCannotModifyRequestHeaders'
  | 'schema'

export type DnrRuleProblem = {
  error: DnrParseError
  ruleId: number
  /** The text Chrome reports for this rule. */
  message: string
}

const TEMPLATES: Record<Exclude<DnrParseError, 'schema'>, string> = {
  requestMethodDuplicated: 'Rule with id * includes and excludes the same request method.',
  resourceTypeDuplicated: 'Rule with id * includes and excludes the same resource.',
  invalidRuleId:
    'Rule with id * has an invalid value for * key. This should be greater than or equal to *.',
  invalidRulePriority:
    'Rule with id * has an invalid value for * key. This should be greater than or equal to *.',
  noApplicableResourceTypes: 'Rule with id * is not applicable to any resource type.',
  emptyList: 'Rule with id * cannot have an empty list as the value for * key.',
  domainsAndInitiatorDomains: 'Rule with id * cannot use deprecated field "*". Use "*" instead.',
  excludedDomainsAndExcludedInitiatorDomains:
    'Rule with id * cannot use deprecated field "*". Use "*" instead.',
  emptyUrlFilter: 'Rule with id * cannot have an empty value for * key.',
  invalidRedirectUrl: 'Rule with id * does not provide a valid URL for * key.',
  duplicateIds: 'Rule with id * does not have a unique ID.',
  nonAscii: 'Rule with id * cannot have non-ascii characters as part of "*" key.',
  invalidUrlFilter: 'Rule with id * specifies an incorrect value for the "*" key.',
  invalidRedirect: 'Rule with id * specifies an incorrect value for the "*" key.',
  invalidExtensionPath: 'Rule with id * specifies an incorrect value for the "*" key.',
  invalidTransformScheme:
    'Rule with id * specifies an incorrect value for the "*" key. Allowed values are: [*].',
  invalidTransformPort: 'Rule with id * specifies an incorrect value for the "*" key.',
  invalidTransformQuery: 'Rule with id * specifies an incorrect value for the "*" key.',
  invalidTransformFragment: 'Rule with id * specifies an incorrect value for the "*" key.',
  queryAndTransformBothSpecified: 'Rule with id * cannot specify both "*" and "*" keys.',
  javascriptRedirect:
    'Rule with id * specifies an incorrect value for the "*" key. Redirects to javascript urls are not supported.',
  emptyRegexFilter: 'Rule with id * cannot have an empty value for * key.',
  invalidRegexFilter: 'Rule with id * specifies an incorrect value for the "*" key.',
  regexTooLarge:
    'Rule with id * was skipped as the "*" value exceeded the 2KB memory limit when compiled. Learn more: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#regex-rules',
  multipleFiltersSpecified: 'Rule with id * can only specify one of "*" or "*" keys.',
  regexSubstitutionWithoutFilter:
    'Rule with id * can\'t specify the "*" key without specifying the "*" key.',
  invalidRegexSubstitution: 'Rule with id * specifies an incorrect value for the "*" key.',
  invalidAllowAllRequestsResourceType:
    'Rule with id * is an "allowAllRequests" rule and must specify the "resourceTypes" key. It may only include the "main_frame" and "sub_frame" resource types.',
  noHeadersToModifySpecified:
    'Rule with id * does not specify a value for "*" or "*" key. At least one of these keys must be specified with a non-empty list.',
  invalidHeaderToModifyName: 'Rule with id * must specify a valid header name to be modified.',
  invalidHeaderToModifyValue:
    'Rule with id * must provide a valid header value to be appended/set.',
  headerValueNotSpecified: 'Rule with id * must provide a value for a header to be appended/set.',
  headerValuePresent: 'Rule with id * must not provide a header value for a header to be removed.',
  appendInvalidRequestHeader:
    'Rule with id * specifies an invalid request header to be appended. Only standard HTTP request headers that can specify multiple values for a single entry are supported.',
  tabIdsOnNonSessionRule:
    'Rule with id * specifies a value for "*" or "*" key. These are only supported for session-scoped rules.',
  tabIdDuplicated: 'Rule with id * includes and excludes the same tab ID.',
  invalidMatchingResponseHeaderName: 'Rule with id * must specify a valid header name for "*" key',
  invalidMatchingResponseHeaderValue:
    'Rule with id * must specify a valid header value for "*" key',
  matchingResponseHeaderDuplicated:
    'Rule with id * includes and excludes the same response header.',
  responseHeaderRuleCannotModifyRequestHeaders:
    'Rule with id * which matches on response headers cannot modify request headers.'
}

/** ErrorUtils::FormatErrorMessage: each `*` takes the next argument. */
function formatTemplate(template: string, args: readonly string[]): string {
  let next = 0
  return template.replace(/\*/g, () => args[next++] ?? '*')
}

export function dnrRuleProblem(
  error: Exclude<DnrParseError, 'schema'>,
  ruleId: number,
  ...keys: string[]
): DnrRuleProblem {
  return { error, ruleId, message: formatTemplate(TEMPLATES[error], [String(ruleId), ...keys]) }
}

export function isDnrRuleProblem(value: unknown): value is DnrRuleProblem {
  return typeof value === 'object' && value !== null && 'error' in value && 'ruleId' in value
}
