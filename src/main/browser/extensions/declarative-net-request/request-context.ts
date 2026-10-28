import { hostLabelSuffixes, sameDomainOrHost } from './domain-matching'
import { dnrNgramDictionary } from './ngram-dictionary'
import { ELEMENT_TYPE, requestMethodBit, resourceTypeBit } from './rule-flags'
import type { DnrResourceType } from './rule-types'
import type { DnrUrlText } from './url-pattern'
import { dnrUrlHost, dnrUrlText, toLowerAscii } from './url-text'

// Everything a rule looks at for one request, computed once and shared by every ruleset
// (request_params.cc RequestParams).

export type DnrRequestInfo = {
  /** The request URL exactly as Chromium reports it (webRequest details.url). */
  url: string
  /** HTTP method, any case. */
  method: string
  type: DnrResourceType
  /** Serialised initiator origin; null (or "null") for opaque or browser-initiated requests. */
  initiator: string | null
  /** -1 when the request does not belong to a tab. */
  tabId: number
  /** Origin of the outermost main frame, used by topDomains for non-main-frame requests. */
  topFrameOrigin?: string | null
}

/** Response headers as Electron's onHeadersReceived reports them. */
export type DnrResponseHeaders = Readonly<Record<string, string | readonly string[]>>

export type DnrRequestContext = {
  url: DnrUrlText
  requestHost: string
  requestHostSuffixes: string[]
  /** Null when the initiator origin is opaque. */
  initiatorHost: string | null
  initiatorHostSuffixes: string[]
  /** Initiator scheme, so requests other extensions start can be skipped. */
  initiatorScheme: string | null
  topHost: string
  topHostSuffixes: string[]
  elementType: number
  method: number
  isThirdParty: boolean
  tabId: number
  /** Lower-cased header name to lower-cased values (comma lists split like net does). */
  responseHeaders: ReadonlyMap<string, string[]> | null
  ngramIds: number[]
  /** Set once an engine has routed this request's n-gram and domain hits to its partitions. */
  ngramEpoch: number | null
}

type Origin = { scheme: string; host: string } | null

/** Host of a serialised origin; null when opaque. */
export function dnrOriginHost(origin: string | null | undefined): string | null {
  return parseOrigin(origin)?.host ?? null
}

function parseOrigin(origin: string | null | undefined): Origin {
  if (!origin || origin === 'null') {
    return null
  }
  const match = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(origin)
  return match ? { scheme: match[1].toLowerCase(), host: toLowerAscii(match[2]) } : null
}

// net::HttpUtil::IsNonCoalescingHeader: these headers are never split on commas.
const NON_COALESCING_HEADERS = new Set([
  'date',
  'expires',
  'last-modified',
  'location',
  'retry-after',
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
  'strict-transport-security'
])

/** HttpUtil::ValuesIterator: comma-separated, quote-aware, LWS-trimmed, empties kept. */
function splitHeaderValues(value: string): string[] {
  const values: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (quoted && char === '\\' && i + 1 < value.length) {
      current += char + value[++i]
      continue
    }
    if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      values.push(current.replace(/^[ \t]+|[ \t]+$/g, ''))
      current = ''
      continue
    }
    current += char
  }
  values.push(current.replace(/^[ \t]+|[ \t]+$/g, ''))
  return values
}

function normalizeResponseHeaders(headers: DnrResponseHeaders): Map<string, string[]> {
  const normalized = new Map<string, string[]>()
  for (const [name, raw] of Object.entries(headers)) {
    const key = toLowerAscii(name)
    const lines = typeof raw === 'string' ? [raw] : raw
    const values = normalized.get(key) ?? []
    for (const line of lines) {
      const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, '')
      const split =
        NON_COALESCING_HEADERS.has(key) || !trimmed.includes(',')
          ? [trimmed]
          : splitHeaderValues(trimmed)
      values.push(...split.map(toLowerAscii))
    }
    normalized.set(key, values)
  }
  return normalized
}

/** Returns null for URLs url_pattern_index never matches (unparsable or over 2MB). */
export function createDnrRequestContext(
  request: DnrRequestInfo,
  responseHeaders: DnrResponseHeaders | null = null
): DnrRequestContext | null {
  const url = dnrUrlText(request.url)
  if (url === null) {
    return null
  }
  const requestHost = dnrUrlHost(url)
  const initiator = parseOrigin(request.initiator)
  // A main frame's top domain is its own host; otherwise the outermost frame, else the initiator.
  const top =
    request.type === 'main_frame'
      ? requestHost
      : (parseOrigin(request.topFrameOrigin)?.host ?? initiator?.host ?? '')
  const scheme = url.lowerSpec.slice(0, url.lowerSpec.indexOf(':'))
  const isHttp = scheme === 'http' || scheme === 'https'
  return {
    url,
    requestHost,
    requestHostSuffixes: hostLabelSuffixes(requestHost),
    initiatorHost: initiator?.host ?? null,
    initiatorHostSuffixes: initiator ? hostLabelSuffixes(initiator.host) : [],
    initiatorScheme: initiator?.scheme ?? null,
    topHost: top,
    topHostSuffixes: hostLabelSuffixes(top),
    elementType: resourceTypeBit(request.type),
    method: requestMethodBit(isHttp, request.method),
    // An opaque or missing initiator makes every request third-party.
    isThirdParty: initiator === null || !sameDomainOrHost(requestHost, initiator.host),
    tabId: request.tabId,
    responseHeaders: responseHeaders === null ? null : normalizeResponseHeaders(responseHeaders),
    ngramIds: dnrNgramDictionary().urlNgramIds(url.lowerSpec),
    ngramEpoch: null
  }
}

/** ShouldCollapseResourceType: blocked images and frames are collapsed in the page. */
export function isCollapsibleType(context: DnrRequestContext): boolean {
  return (
    context.elementType === ELEMENT_TYPE.image || context.elementType === ELEMENT_TYPE.subDocument
  )
}
