import { describe, expect, it } from 'vitest'
import { buildGuestOverlayScript } from './grab-guest-script'

describe('buildGuestOverlayScript', () => {
  it('returns a non-empty string for arm action', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(100)
  })

  it('returns a non-empty string for awaitClick action', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
  })

  it('returns a non-empty string for finalize action', () => {
    const script = buildGuestOverlayScript('finalize')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
  })

  it('returns a non-empty string for teardown action', () => {
    const script = buildGuestOverlayScript('teardown')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
  })

  it('arm script contains shadow DOM setup', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('attachShadow')
    expect(script).toContain('__orca-grab-host')
    expect(script).toContain('__orcaGrab')
  })

  it('arm script contains budget constants matching shared types', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('textSnippetMaxLength: 200')
    expect(script).toContain('nearbyTextMaxEntries: 10')
    expect(script).toContain('htmlSnippetMaxLength: 4096')
  })

  it('arm script contains secret pattern redaction', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('access_token')
    expect(script).toContain('api_key')
    expect(script).toContain('password')
    expect(script).toContain('secret')
    expect(script).toContain('[redacted]')
  })

  it('arm script strips script tags from HTML snippets', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain("querySelectorAll('script')")
  })

  it('arm script only allows safe attributes', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('SAFE_ATTRS')
    expect(script).toContain("'id'")
    expect(script).toContain("'class'")
    expect(script).toContain("'role'")
  })

  it('awaitClick script returns a Promise', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toContain('new Promise')
    expect(script).toContain('resolve')
    expect(script).toContain('reject')
  })

  it('awaitClick script freezes highlight on selection instead of cleanup', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toContain('freezeHighlight')
    expect(script).not.toContain('grab.cleanup();\n    resolve')
  })

  it('arm script defines freezeHighlight method', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('freezeHighlight')
    expect(script).toContain("pointerEvents = 'none'")
  })

  it('awaitClick script blocks right-click', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toContain('contextmenu')
    expect(script).toContain('preventDefault')
  })

  it('teardown script cleans up the overlay', () => {
    const script = buildGuestOverlayScript('teardown')
    expect(script).toContain('cleanup')
    expect(script).toContain('__orcaGrab')
  })

  it('teardown script cancels pending awaitClick', () => {
    const script = buildGuestOverlayScript('teardown')
    expect(script).toContain('cancelAwait')
  })

  it('arm script uses full-viewport overlay as click catcher', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('pointer-events:all')
    expect(script).toContain('cursor:crosshair')
    expect(script).toContain('100vw')
    expect(script).toContain('100vh')
  })

  it('arm script sanitizes URLs by stripping query strings', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('sanitizeUrl')
    expect(script).toContain("u.search = ''")
    expect(script).toContain("u.hash = ''")
  })

  it('arm script sanitizeUrl returns empty string on parse failure', () => {
    const script = buildGuestOverlayScript('arm')
    // The catch block should return '' not the raw URL
    expect(script).toContain("return '';")
  })

  it('arm script slices text nodes before normalizing bounded text', () => {
    const script = buildGuestOverlayScript('arm')

    expect(script).toContain("normalizeText((node.nodeValue || '').slice(0, remaining))")
    expect(script).toContain('value = value.slice(start, end)')
    expect(script).not.toContain('normalizeText(node.nodeValue ||')
    expect(script).not.toContain("(el.textContent || '').trim()")
    expect(script).not.toContain('ref.textContent')
  })

  it('arm script walks nearby siblings without materializing sibling arrays', () => {
    const script = buildGuestOverlayScript('arm')

    expect(script).toContain('previousElementSibling')
    expect(script).toContain('nextElementSibling')
    expect(script).not.toContain('Array.from(parent.children)')
  })
})
