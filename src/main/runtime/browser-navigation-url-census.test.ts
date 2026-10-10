/**
 * The confinement fence is only as good as the set of methods that call it. This census fails
 * when a browser RPC method gains a URL-shaped param without being classified, so the next
 * navigation method cannot ship unfenced the way `browser.goto` did.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BROWSER_CORE_METHODS } from './rpc/methods/browser-core'
import { BROWSER_EXTRA_METHODS } from './rpc/methods/browser-extras'
import { BROWSER_TEXT_METHODS } from './rpc/methods/browser-text-rpc-methods'

/** Methods whose URL reaches a host-rendered page; each calls guardPairedBrowserNavigation. */
const FENCED = ['browser.goto', 'browser.tabCreate']

/** Methods carrying a URL that never becomes a navigation on this host, and why. */
const EXEMPT: Record<string, string> = {
  'browser.openUrl': 'rejects non-http(s) before it re-enters browserTabCreate',
  'browser.wait': 'a match predicate the caller waits on, never navigated to',
  'browser.cookie.get': 'cookie scoping, not a navigation',
  'browser.cookie.delete': 'cookie scoping, not a navigation'
}

function urlParamNames(schema: unknown): string[] {
  if (!(schema instanceof z.ZodObject)) {
    return []
  }
  return Object.keys(schema.shape as Record<string, unknown>).filter((key) =>
    /^url$|Url$/.test(key)
  )
}

describe('browser RPC URL-param census', () => {
  const methods = [...BROWSER_CORE_METHODS, ...BROWSER_EXTRA_METHODS, ...BROWSER_TEXT_METHODS]

  it('classifies every browser method that takes a URL', () => {
    const takingUrl = methods
      .filter((method) => urlParamNames(method.params).length > 0)
      .map((method) => method.name)
      .sort()

    expect(takingUrl).toEqual([...FENCED, ...Object.keys(EXEMPT)].sort())
  })

  it('gives every exemption a stated reason', () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason, `${name} needs a reason it is safe unfenced`).not.toBe('')
    }
    expect(FENCED.filter((name) => name in EXEMPT)).toEqual([])
  })
})
