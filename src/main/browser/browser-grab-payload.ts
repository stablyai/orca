import type { BrowserGrabPayload, BrowserGrabRect } from '../../shared/browser-grab-types'
import {
  GRAB_BUDGET,
  GRAB_SAFE_ATTRIBUTE_NAMES,
  GRAB_SECRET_PATTERNS
} from '../../shared/browser-grab-types'

const SAFE_GRAB_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

/** Revalidate untrusted guest payloads before forwarding them to renderer chrome. */
export function clampGrabPayload(raw: unknown): BrowserGrabPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  if (!obj.page || typeof obj.page !== 'object') {
    return null
  }
  if (!obj.target || typeof obj.target !== 'object') {
    return null
  }

  const page = obj.page as Record<string, unknown>
  const target = obj.target as Record<string, unknown>

  const clampStr = (s: unknown, max: number): string => {
    const str = typeof s === 'string' ? s : ''
    if (str.length <= max) {
      return str
    }
    return `${str.slice(0, max)} (truncated)`
  }

  const clampArray = (arr: unknown, maxEntries: number, maxEntryLength: number): string[] => {
    const items = Array.isArray(arr) ? arr : []
    return items.slice(0, maxEntries).map((item) => clampStr(item, maxEntryLength))
  }

  const safeStr = (s: unknown, max = 500): string => clampStr(s, max)

  const safeNum = (n: unknown, fallback = 0): number =>
    typeof n === 'number' && Number.isFinite(n) ? n : fallback

  // Repeat guest-side secret heuristics at the main-process boundary.
  const containsSecret = (val: string): boolean => {
    const lower = val.toLowerCase()
    return GRAB_SECRET_PATTERNS.some((p) => lower.includes(p))
  }

  // Strip queries and fragments, which may contain tokens.
  const sanitizeUrl = (rawUrl: unknown): string => {
    const str = typeof rawUrl === 'string' ? rawUrl : ''
    if (!str) {
      return ''
    }
    try {
      const url = new URL(str)
      if (url.protocol === 'about:') {
        return url.toString() === 'about:blank' ? 'about:blank' : ''
      }
      if (!SAFE_GRAB_URL_PROTOCOLS.has(url.protocol)) {
        return ''
      }
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return ''
    }
  }

  const safeAttributes = (attrs: unknown): Record<string, string> => {
    if (!attrs || typeof attrs !== 'object') {
      return {}
    }
    const filtered: Record<string, string> = {}
    for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
      const name = key.toLowerCase()
      const isAria = name.startsWith('aria-')
      const isSafe = GRAB_SAFE_ATTRIBUTE_NAMES.has(name)
      if (!isAria && !isSafe) {
        continue
      }
      const strValue = safeStr(value, 2000)
      if (containsSecret(strValue)) {
        filtered[name] = '[redacted]'
      } else if ((name === 'href' || name === 'src' || name === 'action') && strValue) {
        filtered[name] = sanitizeUrl(strValue)
      } else if (name === 'class') {
        filtered[name] = safeStr(value, 200)
      } else {
        filtered[name] = safeStr(value, 500)
      }
    }
    return filtered
  }

  const safeMetadataStr = (value: unknown, max: number): string => {
    const strValue = safeStr(value, max)
    return strValue && containsSecret(strValue) ? '[redacted]' : strValue
  }

  const safeNullableMetadataStr = (value: unknown, max: number): string | null =>
    safeMetadataStr(value, max) || null

  const safeMetadataArray = (
    arr: unknown,
    maxEntries: number,
    maxEntryLength: number
  ): string[] => {
    const items = Array.isArray(arr) ? arr : []
    return items
      .slice(0, maxEntries)
      .map((item) => safeMetadataStr(item, maxEntryLength))
      .filter(Boolean)
  }

  const safeRect = (r: unknown): BrowserGrabRect => {
    if (!r || typeof r !== 'object') {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
    const rect = r as Record<string, unknown>
    return {
      x: safeNum(rect.x),
      y: safeNum(rect.y),
      width: safeNum(rect.width),
      height: safeNum(rect.height)
    }
  }

  const accessibility = target.accessibility as Record<string, unknown> | null | undefined
  const computedStyles = target.computedStyles as Record<string, unknown> | null | undefined

  return {
    page: {
      sanitizedUrl: sanitizeUrl(page.sanitizedUrl),
      title: safeStr(page.title, 500),
      viewportWidth: safeNum(page.viewportWidth),
      viewportHeight: safeNum(page.viewportHeight),
      scrollX: safeNum(page.scrollX),
      scrollY: safeNum(page.scrollY),
      devicePixelRatio: safeNum(page.devicePixelRatio, 1),
      capturedAt: safeStr(page.capturedAt, 100)
    },
    target: {
      tagName: safeStr(target.tagName, 50),
      selector: safeStr(target.selector, GRAB_BUDGET.selectorMaxLength),
      elementPath: safeMetadataStr(target.elementPath, GRAB_BUDGET.pathMaxLength),
      fullPath: safeMetadataStr(target.fullPath, GRAB_BUDGET.pathMaxLength),
      cssClasses: safeMetadataStr(target.cssClasses, GRAB_BUDGET.cssClassesMaxLength),
      nearbyElements: safeMetadataArray(
        target.nearbyElements,
        GRAB_BUDGET.nearbyElementsMaxEntries,
        GRAB_BUDGET.nearbyElementMaxLength
      ),
      selectedText: safeMetadataStr(target.selectedText, GRAB_BUDGET.selectedTextMaxLength) || null,
      isFixed: target.isFixed === true,
      reactComponents: safeNullableMetadataStr(
        target.reactComponents,
        GRAB_BUDGET.reactComponentsMaxLength
      ),
      sourceFile: safeNullableMetadataStr(target.sourceFile, GRAB_BUDGET.sourceFileMaxLength),
      textSnippet: clampStr(target.textSnippet, GRAB_BUDGET.textSnippetMaxLength),
      htmlSnippet: clampStr(target.htmlSnippet, GRAB_BUDGET.htmlSnippetMaxLength),
      attributes: safeAttributes(target.attributes),
      accessibility: {
        role: safeNullableMetadataStr(accessibility?.role, 500),
        accessibleName: safeNullableMetadataStr(accessibility?.accessibleName, 500),
        ariaLabel: safeNullableMetadataStr(accessibility?.ariaLabel, 500),
        ariaLabelledBy: safeNullableMetadataStr(accessibility?.ariaLabelledBy, 500)
      },
      rectViewport: safeRect(target.rectViewport),
      rectPage: safeRect(target.rectPage),
      computedStyles: {
        display: safeStr(computedStyles?.display),
        position: safeStr(computedStyles?.position),
        width: safeStr(computedStyles?.width),
        height: safeStr(computedStyles?.height),
        margin: safeStr(computedStyles?.margin),
        padding: safeStr(computedStyles?.padding),
        color: safeStr(computedStyles?.color),
        backgroundColor: safeStr(computedStyles?.backgroundColor),
        border: safeStr(computedStyles?.border),
        borderRadius: safeStr(computedStyles?.borderRadius),
        fontFamily: safeStr(computedStyles?.fontFamily),
        fontSize: safeStr(computedStyles?.fontSize),
        fontWeight: safeStr(computedStyles?.fontWeight),
        lineHeight: safeStr(computedStyles?.lineHeight),
        textAlign: safeStr(computedStyles?.textAlign),
        zIndex: safeStr(computedStyles?.zIndex)
      }
    },
    nearbyText: clampArray(
      obj.nearbyText,
      GRAB_BUDGET.nearbyTextMaxEntries,
      GRAB_BUDGET.nearbyTextEntryMaxLength
    ),
    ancestorPath: clampArray(obj.ancestorPath, GRAB_BUDGET.ancestorPathMaxEntries, 200),
    screenshot: null
  }
}
