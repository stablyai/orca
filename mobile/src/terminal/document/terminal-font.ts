import type { TerminalDocumentScope } from './document-scope'
import { defaultTerminalFontFamily, refitGridToHostFrame } from './text-scaling'

/** A font file the user imported, as a `data:` URL; null restores the default stack. */
export type TerminalCustomFont = { source: string } | null

type SharedFace = { family: string; loaded: Promise<FontFace>; refs: number }

// Why shared: the page hosts every pane's document on one `document.fonts`, so one face per file
// is decoded once and outlives any single pane; the WebView's document holds just its own.
let sharedFacesBySource: Map<string, SharedFace> | null = null
let nextCustomFamilyId = 0

function sharedFaces(): Map<string, SharedFace> {
  return (sharedFacesBySource ??= new Map())
}

function acquireFace(source: string): SharedFace {
  let shared = sharedFaces().get(source)
  if (!shared) {
    const family = `Orca Terminal Font ${++nextCustomFamilyId}`
    const face = new FontFace(family, `url(${source})`)
    const loaded = face.load().then((ready) => {
      document.fonts.add(ready)
      return ready
    })
    shared = { family, loaded, refs: 0 }
    sharedFaces().set(source, shared)
  }
  shared.refs++
  return shared
}

function releaseFace(source: string | null) {
  const shared = source === null ? undefined : sharedFaces().get(source)
  if (!source || !shared || --shared.refs > 0) {
    return
  }
  sharedFaces().delete(source)
  shared.loaded.then(
    (face) => {
      try {
        document.fonts.delete(face)
      } catch {}
    },
    () => {}
  )
}

export function applyTerminalFont(scope: TerminalDocumentScope, font: TerminalCustomFont) {
  const request = ++scope.customFontRequest
  if (!font) {
    releaseFace(scope.customFontSource)
    scope.customFontSource = null
    setTerminalFontFamily(scope, defaultTerminalFontFamily())
    return
  }
  if (font.source === scope.customFontSource) {
    return
  }
  if (typeof FontFace !== 'function' || !document.fonts) {
    return
  }
  let shared: SharedFace
  try {
    shared = acquireFace(font.source)
  } catch {
    return
  }
  shared.loaded.then(
    () => {
      if (request !== scope.customFontRequest) {
        releaseFace(font.source)
        return
      }
      releaseFace(scope.customFontSource)
      scope.customFontSource = font.source
      // Why: the user's face leads; the default stack still covers glyphs it lacks.
      setTerminalFontFamily(scope, `"${shared.family}", ${defaultTerminalFontFamily()}`)
    },
    () => releaseFace(font.source)
  )
}

function setTerminalFontFamily(scope: TerminalDocumentScope, family: string) {
  if (scope.terminalFontFamily === family) {
    return
  }
  scope.terminalFontFamily = family
  const term = scope.term
  if (!term) {
    return
  }
  term.options.fontFamily = family
  refitGridToHostFrame(scope, 'font-family')
}

export function stopTerminalFont(scope: TerminalDocumentScope) {
  scope.customFontRequest++
  releaseFace(scope.customFontSource)
  scope.customFontSource = null
}
