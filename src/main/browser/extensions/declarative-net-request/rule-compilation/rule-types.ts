// Chrome's chrome.declarativeNetRequest rule JSON, as declared in
// extensions/common/api/declarative_net_request.webidl (Chromium 150).

export const DNR_RESOURCE_TYPES = [
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
] as const
export type DnrResourceType = (typeof DNR_RESOURCE_TYPES)[number]

export const DNR_REQUEST_METHODS = [
  'connect',
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'other'
] as const
export type DnrRequestMethod = (typeof DNR_REQUEST_METHODS)[number]

export const DNR_ACTION_TYPES = [
  'block',
  'redirect',
  'allow',
  'upgradeScheme',
  'modifyHeaders',
  'allowAllRequests'
] as const
export type DnrActionType = (typeof DNR_ACTION_TYPES)[number]

export const DNR_HEADER_OPERATIONS = ['append', 'set', 'remove'] as const
export type DnrHeaderOperation = (typeof DNR_HEADER_OPERATIONS)[number]

export type DnrDomainType = 'firstParty' | 'thirdParty'

export type DnrQueryKeyValue = { key: string; value: string; replaceOnly?: boolean }

export type DnrQueryTransform = {
  removeParams?: string[]
  addOrReplaceParams?: DnrQueryKeyValue[]
}

export type DnrUrlTransform = {
  scheme?: string
  host?: string
  port?: string
  path?: string
  query?: string
  queryTransform?: DnrQueryTransform
  fragment?: string
  username?: string
  password?: string
}

export type DnrRedirect = {
  extensionPath?: string
  transform?: DnrUrlTransform
  url?: string
  regexSubstitution?: string
}

export type DnrHeaderInfo = { header: string; values?: string[]; excludedValues?: string[] }

export type DnrModifyHeaderInfo = {
  header: string
  operation: DnrHeaderOperation
  value?: string
  regexFilter?: string
  regexSubstitution?: string
  regexOptions?: { matchAll?: boolean }
}

export type DnrRuleCondition = {
  urlFilter?: string
  regexFilter?: string
  isUrlFilterCaseSensitive?: boolean
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  requestDomains?: string[]
  excludedRequestDomains?: string[]
  topDomains?: string[]
  excludedTopDomains?: string[]
  domains?: string[]
  excludedDomains?: string[]
  resourceTypes?: DnrResourceType[]
  excludedResourceTypes?: DnrResourceType[]
  requestMethods?: DnrRequestMethod[]
  excludedRequestMethods?: DnrRequestMethod[]
  domainType?: DnrDomainType
  tabIds?: number[]
  excludedTabIds?: number[]
  responseHeaders?: DnrHeaderInfo[]
  excludedResponseHeaders?: DnrHeaderInfo[]
}

export type DnrRuleAction = {
  type: DnrActionType
  redirect?: DnrRedirect
  requestHeaders?: DnrModifyHeaderInfo[]
  responseHeaders?: DnrModifyHeaderInfo[]
}

export type DnrRule = {
  id: number
  priority?: number
  condition: DnrRuleCondition
  action: DnrRuleAction
}

// Public ruleset ids reported by getMatchedRules for the two non-static sources.
export const DNR_DYNAMIC_RULESET_ID = '_dynamic'
export const DNR_SESSION_RULESET_ID = '_session'

// Rule sources in Chromium's RulesetID numbering: session -1, dynamic 0, static 1..n
// (manifest order). Equal-priority ties between rulesets go to the larger number.
export type DnrRulesetSource =
  | { kind: 'session' }
  | { kind: 'dynamic' }
  | { kind: 'static'; id: string; manifestIndex: number }

export function dnrRulesetOrdinal(source: DnrRulesetSource): number {
  if (source.kind === 'session') {
    return -1
  }
  return source.kind === 'dynamic' ? 0 : source.manifestIndex + 1
}

export function dnrPublicRulesetId(source: DnrRulesetSource): string {
  if (source.kind === 'session') {
    return DNR_SESSION_RULESET_ID
  }
  return source.kind === 'dynamic' ? DNR_DYNAMIC_RULESET_ID : source.id
}
