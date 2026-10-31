import { dnrRuleProblem, type DnrRuleProblem } from './parse-errors'
import type { DnrRedirect, DnrUrlTransform } from './rule-types'

// Redirect parsing (indexed_rule.cc ParseRedirect/ValidateTransform, flat_ruleset_indexer.cc
// BuildTransformOffset) and application (ruleset_matcher_base.cc GetTransformedURL,
// GetModifiedQuery, GetUpgradedUrl).

type Component = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; value: string }

export type DnrUrlTransformSpec = {
  scheme?: string
  host?: string
  port: Component
  path: Component
  query: Component
  fragment: Component
  username?: string
  password?: string
  removeParams: ReadonlySet<string>
  addOrReplaceParams: { key: string; value: string; replaceOnly: boolean }[]
}

export type DnrRedirectSpec =
  | { kind: 'url'; url: string }
  | { kind: 'transform'; transform: DnrUrlTransformSpec }
  | { kind: 'regexSubstitution'; substitution: string }

const ALLOWED_TRANSFORM_SCHEMES = ['http', 'https', 'ftp', 'chrome-extension']

function parsedUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** base::EscapeQueryParamValue(use_plus=true): the encodeURIComponent set, space as '+'. */
export function escapeQueryParamValue(text: string): string {
  return encodeURIComponent(text.toWellFormed()).replace(/%20/g, '+')
}

function component(value: string | undefined, separator: string): Component {
  if (value === undefined) {
    return { kind: 'keep' }
  }
  if (value === '') {
    return { kind: 'clear' }
  }
  return { kind: 'set', value: separator && value.startsWith(separator) ? value.slice(1) : value }
}

function transformSpec(transform: DnrUrlTransform): DnrUrlTransformSpec {
  const removeParams = new Set(
    (transform.queryTransform?.removeParams ?? []).map(escapeQueryParamValue)
  )
  return {
    scheme: transform.scheme,
    host: transform.host,
    port: component(transform.port, ''),
    path: component(transform.path, ''),
    query: component(transform.query, '?'),
    fragment: component(transform.fragment, '#'),
    username: transform.username,
    password: transform.password,
    removeParams,
    addOrReplaceParams: (transform.queryTransform?.addOrReplaceParams ?? []).map((param) => ({
      key: escapeQueryParamValue(param.key),
      value: escapeQueryParamValue(param.value),
      replaceOnly: param.replaceOnly === true
    }))
  }
}

function transformProblem(transform: DnrUrlTransform, ruleId: number): DnrRuleProblem | null {
  if (transform.scheme !== undefined && !ALLOWED_TRANSFORM_SCHEMES.includes(transform.scheme)) {
    return dnrRuleProblem(
      'invalidTransformScheme',
      ruleId,
      'action.redirect.transform.scheme',
      ALLOWED_TRANSFORM_SCHEMES.join(', ')
    )
  }
  const { port, query, fragment } = transform
  // base::StringToUint accepts a leading '+'.
  if (port && !(/^\+?\d+$/.test(port) && Number(port) <= 65535)) {
    return dnrRuleProblem('invalidTransformPort', ruleId, 'action.redirect.transform.port')
  }
  if (query && !query.startsWith('?')) {
    return dnrRuleProblem('invalidTransformQuery', ruleId, 'action.redirect.transform.query')
  }
  if (fragment && !fragment.startsWith('#')) {
    return dnrRuleProblem('invalidTransformFragment', ruleId, 'action.redirect.transform.fragment')
  }
  if (query !== undefined && transform.queryTransform !== undefined) {
    return dnrRuleProblem(
      'queryAndTransformBothSpecified',
      ruleId,
      'action.redirect.transform.query',
      'action.redirect.transform.queryTransform'
    )
  }
  return null
}

/** ParseRedirect: url wins over extensionPath over transform over regexSubstitution. */
export function parseDnrRedirect(
  redirect: DnrRedirect,
  ruleId: number,
  extensionId: string
): DnrRedirectSpec | DnrRuleProblem {
  if (redirect.url !== undefined) {
    const url = parsedUrl(redirect.url)
    if (url === null) {
      return dnrRuleProblem('invalidRedirectUrl', ruleId, 'action.redirect.url')
    }
    if (url.protocol === 'javascript:') {
      return dnrRuleProblem('javascriptRedirect', ruleId, 'action.redirect.url')
    }
    return { kind: 'url', url: url.href }
  }
  if (redirect.extensionPath !== undefined) {
    const resolved = redirect.extensionPath.startsWith('/')
      ? parsedUrl(`chrome-extension://${extensionId}${redirect.extensionPath}`)
      : null
    if (resolved === null) {
      return dnrRuleProblem('invalidExtensionPath', ruleId, 'action.redirect.extensionPath')
    }
    return { kind: 'url', url: resolved.href }
  }
  if (redirect.transform !== undefined) {
    return (
      transformProblem(redirect.transform, ruleId) ?? {
        kind: 'transform',
        transform: transformSpec(redirect.transform)
      }
    )
  }
  if (redirect.regexSubstitution !== undefined) {
    if (redirect.regexSubstitution === '') {
      return dnrRuleProblem('invalidRegexSubstitution', ruleId, 'action.redirect.regexSubstitution')
    }
    return { kind: 'regexSubstitution', substitution: redirect.regexSubstitution }
  }
  return dnrRuleProblem('invalidRedirect', ruleId, 'action.redirect')
}

/** url::ExtractQueryKeyValue: empty middle pairs are kept, a trailing '&' is not. */
function queryPairs(query: string): [string, string][] {
  const pairs: [string, string][] = []
  let position = 0
  while (position < query.length) {
    const amp = query.indexOf('&', position)
    const end = amp === -1 ? query.length : amp
    const piece = query.slice(position, end)
    const equals = piece.indexOf('=')
    pairs.push(equals === -1 ? [piece, ''] : [piece.slice(0, equals), piece.slice(equals + 1)])
    position = end + 1
  }
  return pairs
}

/** GetModifiedQuery: null when nothing changed. */
function modifiedQuery(query: string, transform: DnrUrlTransformSpec): string | null {
  if (transform.removeParams.size === 0 && transform.addOrReplaceParams.length === 0) {
    return null
  }
  const pending = [...transform.addOrReplaceParams]
  const parts: string[] = []
  let changed = false
  for (const [key, value] of queryPairs(query)) {
    if (transform.removeParams.has(key)) {
      changed = true
      continue
    }
    const replaceIndex = pending.findIndex((param) => param.key === key)
    if (replaceIndex === -1) {
      parts.push(`${key}=${value}`)
      continue
    }
    changed = true
    parts.push(`${key}=${pending[replaceIndex].value}`)
    pending.splice(replaceIndex, 1)
  }
  for (const param of pending) {
    if (!param.replaceOnly) {
      parts.push(`${param.key}=${param.value}`)
      changed = true
    }
  }
  return changed ? parts.join('&') : null
}

function applyComponent(original: string | null, change: Component): string | null {
  if (change.kind === 'keep') {
    return original
  }
  return change.kind === 'clear' ? null : change.value
}

/** Query and fragment as GURL components: null when absent, '' when present but empty. */
function queryAndFragment(href: string): { query: string | null; fragment: string | null } {
  const hash = href.indexOf('#')
  const beforeHash = hash === -1 ? href : href.slice(0, hash)
  const question = beforeHash.indexOf('?')
  return {
    query: question === -1 ? null : beforeHash.slice(question + 1),
    fragment: hash === -1 ? null : href.slice(hash + 1)
  }
}

/** GURL::ReplaceComponents stand-in: canonicalise each component independently. */
export function transformDnrUrl(requestUrl: string, transform: DnrUrlTransformSpec): string | null {
  const url = parsedUrl(requestUrl)
  if (url === null) {
    return null
  }
  const original = queryAndFragment(url.href)
  let query = applyComponent(original.query, transform.query)
  if (transform.query.kind === 'keep') {
    const modified = modifiedQuery(original.query ?? '', transform)
    if (modified !== null) {
      query = modified === '' ? null : modified
    }
  }
  const fragment = applyComponent(original.fragment, transform.fragment)
  const host = transform.host ?? url.hostname
  if (/[/\\?#@\s]/.test(host)) {
    return null
  }
  const scheme = transform.scheme ?? url.protocol.slice(0, -1)
  const result = parsedUrl(`${scheme}://${host}/`)
  if (!result || result.port || (host.includes(':') && !/^\[[^\]]+\]$/.test(host))) {
    return null
  }
  const port = applyComponent(url.port, transform.port) ?? ''
  result.port = port ? String(Number(port)) : ''
  result.username = transform.username ?? url.username
  result.password = transform.password ?? url.password
  result.pathname = applyComponent(url.pathname, transform.path) ?? ''
  result.search = query === null ? '' : `?${query}`
  result.hash = fragment === null ? '' : `#${fragment}`
  return result.href
}

/** CreateUpgradeAction: only http and ftp upgrade; anything else yields no action. */
export function upgradeDnrUrl(requestUrl: string): string | null {
  const url = parsedUrl(requestUrl)
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'ftp:')) {
    return null
  }
  return transformDnrUrl(requestUrl, {
    scheme: 'https',
    port: { kind: 'keep' },
    path: { kind: 'keep' },
    query: { kind: 'keep' },
    fragment: { kind: 'keep' },
    removeParams: new Set(),
    addOrReplaceParams: []
  })
}
