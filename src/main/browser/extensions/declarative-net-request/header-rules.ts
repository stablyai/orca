import { dnrRuleProblem, type DnrRuleProblem } from './parse-errors'
import type { DnrHeaderInfo, DnrHeaderOperation, DnrModifyHeaderInfo } from './rule-types'
import { toLowerAscii } from './url-text'

// Header validation from indexed_rule.cc (ValidateHeadersForModification,
// ValidateResponseHeadersForMatching) and the request-header append allowlist with each
// header's join delimiter (constants.h kDNRRequestHeaderAppendAllowList).

export const REQUEST_HEADER_APPEND_DELIMITERS: ReadonlyMap<string, string> = new Map([
  ['accept', ', '],
  ['accept-encoding', ', '],
  ['accept-language', ', '],
  ['access-control-request-headers', ', '],
  ['cache-control', ', '],
  ['connection', ', '],
  ['content-language', ', '],
  ['cookie', '; '],
  ['forwarded', ', '],
  ['if-match', ', '],
  ['if-none-match', ', '],
  ['keep-alive', ', '],
  ['range', ', '],
  ['te', ', '],
  ['trailer', ''],
  ['transfer-encoding', ', '],
  ['upgrade', ', '],
  ['user-agent', ' '],
  ['via', ', '],
  ['want-digest', ', '],
  ['x-forwarded-for', ', ']
])

export type DnrHeaderModification = {
  /** Lower-cased, as the flat ruleset stores it. */
  header: string
  operation: DnrHeaderOperation
  value?: string
}

export type DnrHeaderCondition = {
  header: string
  values: string[] | null
  excludedValues: string[] | null
}

/** net::HttpUtil::IsValidHeaderName: a non-empty RFC 7230 token. */
function isValidHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
}

/** net::HttpUtil::IsValidHeaderValue: no NUL, CR or LF. */
function isValidHeaderValue(value: string): boolean {
  return !/[\0\r\n]/.test(value)
}

export function parseHeaderModifications(
  headers: DnrModifyHeaderInfo[],
  areRequestHeaders: boolean,
  ruleId: number
): DnrHeaderModification[] | DnrRuleProblem {
  if (headers.length === 0) {
    return dnrRuleProblem(
      'emptyList',
      ruleId,
      areRequestHeaders ? 'action.requestHeaders' : 'action.responseHeaders'
    )
  }
  const parsed: DnrHeaderModification[] = []
  for (const info of headers) {
    if (!isValidHeaderName(info.header)) {
      return dnrRuleProblem('invalidHeaderToModifyName', ruleId)
    }
    const header = info.header.toLowerCase()
    if (
      areRequestHeaders &&
      info.operation === 'append' &&
      !REQUEST_HEADER_APPEND_DELIMITERS.has(header)
    ) {
      return dnrRuleProblem('appendInvalidRequestHeader', ruleId)
    }
    if (info.value !== undefined) {
      if (!isValidHeaderValue(info.value)) {
        return dnrRuleProblem('invalidHeaderToModifyValue', ruleId)
      }
      if (info.operation === 'remove') {
        return dnrRuleProblem('headerValuePresent', ruleId)
      }
    } else if (info.operation !== 'remove') {
      return dnrRuleProblem('headerValueNotSpecified', ruleId)
    }
    parsed.push({ header, operation: info.operation, value: info.value })
  }
  return parsed
}

/** Response-header conditions; values are lower-cased because matching is case-insensitive. */
export function parseResponseHeaderConditions(
  included: DnrHeaderInfo[],
  excluded: DnrHeaderInfo[],
  ruleId: number
): { included: DnrHeaderCondition[]; excluded: DnrHeaderCondition[] } | DnrRuleProblem {
  const valuesValid = (info: DnrHeaderInfo): boolean =>
    [...(info.values ?? []), ...(info.excludedValues ?? [])].every(isValidHeaderValue)
  const names = new Set<string>()
  for (const info of included) {
    if (!isValidHeaderName(info.header)) {
      return dnrRuleProblem(
        'invalidMatchingResponseHeaderName',
        ruleId,
        'condition.responseHeaders'
      )
    }
    if (!valuesValid(info)) {
      return dnrRuleProblem(
        'invalidMatchingResponseHeaderValue',
        ruleId,
        'condition.responseHeaders'
      )
    }
    names.add(info.header)
  }
  for (const info of excluded) {
    if (!isValidHeaderName(info.header)) {
      return dnrRuleProblem(
        'invalidMatchingResponseHeaderName',
        ruleId,
        'condition.excludedResponseHeaders'
      )
    }
    if (!valuesValid(info)) {
      return dnrRuleProblem(
        'invalidMatchingResponseHeaderValue',
        ruleId,
        'condition.responseHeaders'
      )
    }
    if (info.values === undefined && info.excludedValues === undefined && names.has(info.header)) {
      return dnrRuleProblem('matchingResponseHeaderDuplicated', ruleId)
    }
  }
  const toCondition = (info: DnrHeaderInfo): DnrHeaderCondition => ({
    header: info.header.toLowerCase(),
    values: info.values?.map(toLowerAscii) ?? null,
    excludedValues: info.excludedValues?.map(toLowerAscii) ?? null
  })
  return { included: included.map(toCondition), excluded: excluded.map(toCondition) }
}
