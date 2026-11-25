import type { DnrActionType, DnrRequestMethod, DnrResourceType } from './rule-types'

// Bit layouts mirror components/url_pattern_index/flat/url_pattern_index.fbs.
export const ELEMENT_TYPE = {
  other: 1,
  script: 2,
  image: 4,
  stylesheet: 8,
  object: 16,
  xmlhttprequest: 32,
  objectSubrequest: 64,
  subDocument: 128,
  ping: 256,
  media: 512,
  font: 1024,
  websocket: 2048,
  webtransport: 4096,
  webbundle: 8192,
  cspReport: 16384,
  mainFrame: 32768
} as const
export const ELEMENT_TYPE_ANY = 65535
// Rules without resourceTypes apply to everything except main_frame.
export const ELEMENT_TYPE_DEFAULT = ELEMENT_TYPE_ANY & ~ELEMENT_TYPE.mainFrame

const RESOURCE_TYPE_BITS: Record<DnrResourceType, number> = {
  main_frame: ELEMENT_TYPE.mainFrame,
  sub_frame: ELEMENT_TYPE.subDocument,
  stylesheet: ELEMENT_TYPE.stylesheet,
  script: ELEMENT_TYPE.script,
  image: ELEMENT_TYPE.image,
  font: ELEMENT_TYPE.font,
  object: ELEMENT_TYPE.object,
  xmlhttprequest: ELEMENT_TYPE.xmlhttprequest,
  ping: ELEMENT_TYPE.ping,
  csp_report: ELEMENT_TYPE.cspReport,
  media: ELEMENT_TYPE.media,
  websocket: ELEMENT_TYPE.websocket,
  webtransport: ELEMENT_TYPE.webtransport,
  webbundle: ELEMENT_TYPE.webbundle,
  other: ELEMENT_TYPE.other
}

export function resourceTypeBit(type: DnrResourceType): number {
  return RESOURCE_TYPE_BITS[type]
}

export const REQUEST_METHOD = {
  connect: 1,
  delete: 2,
  get: 4,
  head: 8,
  options: 16,
  patch: 32,
  post: 64,
  put: 128,
  otherHttp: 256,
  nonHttp: 512
} as const
export const REQUEST_METHOD_ANY = 1023

const RULE_METHOD_BITS: Record<DnrRequestMethod, number> = {
  connect: REQUEST_METHOD.connect,
  delete: REQUEST_METHOD.delete,
  get: REQUEST_METHOD.get,
  head: REQUEST_METHOD.head,
  options: REQUEST_METHOD.options,
  patch: REQUEST_METHOD.patch,
  post: REQUEST_METHOD.post,
  put: REQUEST_METHOD.put,
  other: REQUEST_METHOD.otherHttp
}

export function ruleMethodBit(method: DnrRequestMethod): number {
  return RULE_METHOD_BITS[method]
}

const HTTP_METHOD_BITS: Record<string, number> = {
  CONNECT: REQUEST_METHOD.connect,
  DELETE: REQUEST_METHOD.delete,
  GET: REQUEST_METHOD.get,
  HEAD: REQUEST_METHOD.head,
  OPTIONS: REQUEST_METHOD.options,
  PATCH: REQUEST_METHOD.patch,
  POST: REQUEST_METHOD.post,
  PUT: REQUEST_METHOD.put
}

/** utils.cc GetRequestMethod: non-HTTP(S) URLs (ws:, file:, data:) match only NON_HTTP. */
export function requestMethodBit(isHttpOrHttps: boolean, method: string): number {
  if (!isHttpOrHttps) {
    return REQUEST_METHOD.nonHttp
  }
  return HTTP_METHOD_BITS[method.toUpperCase()] ?? REQUEST_METHOD.otherHttp
}

/** indexed_rule.cc GetActionTypePriority: breaks ties between equal rule priorities. */
function actionTypePriority(type: DnrActionType): number {
  switch (type) {
    case 'allow':
      return 5
    case 'allowAllRequests':
      return 4
    case 'block':
      return 3
    case 'upgradeScheme':
      return 2
    case 'redirect':
      return 1
    case 'modifyHeaders':
      return 0
  }
}

/** ComputeIndexedRulePriority: (priority << 8) | action priority, kept exact in a double. */
export function indexedRulePriority(priority: number, type: DnrActionType): number {
  return priority * 256 + actionTypePriority(type)
}
