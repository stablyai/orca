// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document/document-scope'
import { normalizeStatusDotPresentation } from './document/write-queue'
import { startTextScaling } from './document/text-scaling'

function normalizeStatusDotChunks(chunks: string[]) {
  const scope = createTerminalDocumentScope()
  return chunks.map((chunk) => normalizeStatusDotPresentation(scope, chunk)).join('')
}

/**
 * The font the document picks for this navigator.
 *
 * `startTextScaling` is what assigns it, and it also reads the two scroll elements, so the markup
 * they live in is planted first. The navigator is stubbed rather than injected into an evaluation:
 * the module reads the real one, which is the whole point of the case.
 */
function resolveTerminalFontFamily(navigatorValue: {
  userAgent: string
  platform: string
  maxTouchPoints: number
}) {
  document.body.innerHTML =
    '<div id="scroll-indicator"><div id="scroll-thumb"></div></div>' +
    '<div id="terminal-container"><div id="terminal-surface"></div></div>'
  vi.stubGlobal('navigator', navigatorValue)
  try {
    const scope = createTerminalDocumentScope()
    startTextScaling(scope)
    return scope.terminalFontFamily
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('TerminalWebView text zoom', () => {
  it('normalizes Claude status dots idempotently across write chunks', () => {
    const dot = String.fromCharCode(0x23fa)
    const textSelector = String.fromCharCode(0xfe0e)
    const emojiSelector = String.fromCharCode(0xfe0f)
    const textDot = dot + textSelector

    expect(normalizeStatusDotChunks([dot])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot + emojiSelector])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot + textSelector])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot + textSelector + emojiSelector])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot, emojiSelector, ' ready'])).toBe(`${textDot} ready`)
    expect(normalizeStatusDotChunks([dot, textSelector, ' ready'])).toBe(`${textDot} ready`)
    expect(normalizeStatusDotChunks([dot, textSelector, emojiSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
    expect(normalizeStatusDotChunks([dot, emojiSelector, textSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
    expect(normalizeStatusDotChunks([dot + textSelector, emojiSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
    expect(normalizeStatusDotChunks([dot + emojiSelector, textSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
  })

  const IOS_IPHONE_NAVIGATOR = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15',
    platform: 'iPhone',
    maxTouchPoints: 5
  }
  const ANDROID_NAVIGATOR = {
    userAgent: 'Mozilla/5.0 (Linux; Android 16)',
    platform: 'Linux armv8l',
    maxTouchPoints: 5
  }

  it('starts iOS WebViews on ui-monospace, never SF Mono, still ending in a generic monospace guarantee', () => {
    const fontFamily = resolveTerminalFontFamily(IOS_IPHONE_NAVIGATOR)
    expect(fontFamily.startsWith('ui-monospace, "Menlo"')).toBe(true)
    expect(fontFamily.startsWith('"SF Mono"')).toBe(false)
    // The chain must always terminate in the generic so it can never fall back to
    // a script/proportional system face — the actual iOS bug being fixed.
    expect(fontFamily.endsWith(', monospace')).toBe(true)
  })

  it('treats touch iPadOS WebViews that report MacIntel as iOS for font fallback', () => {
    const fontFamily = resolveTerminalFontFamily({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5
    })
    expect(fontFamily.startsWith('ui-monospace, "Menlo"')).toBe(true)
    expect(fontFamily.startsWith('"SF Mono"')).toBe(false)
    expect(fontFamily.endsWith(', monospace')).toBe(true)
  })

  it('keeps the SF Mono lead outside iOS WebViews and shares the identical fallback tail', () => {
    const androidFontFamily = resolveTerminalFontFamily(ANDROID_NAVIGATOR)
    expect(androidFontFamily.startsWith('"SF Mono", "Menlo"')).toBe(true)
    expect(androidFontFamily.endsWith(', monospace')).toBe(true)
    // Only the lead family may differ across platforms; the rest of the chain is
    // shared so the two platforms cannot silently drift apart.
    const iosFontFamily = resolveTerminalFontFamily(IOS_IPHONE_NAVIGATOR)
    const tailFrom = (family: string) => family.slice(family.indexOf('"Menlo"'))
    expect(tailFrom(androidFontFamily)).toBe(tailFrom(iosFontFamily))
  })
})
