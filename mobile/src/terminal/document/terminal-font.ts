import type { TerminalDocumentScope } from './document-scope'
import { defaultTerminalFontFamily, refitGridToHostFrame } from './text-scaling'

/** A font file the user imported, as a `data:` URL; null restores the default stack. */
export type TerminalCustomFont = { source: string } | null

// Why per document: the page hosts several documents on one `document.fonts`, and a shared
// family name would let one pane's face replace another's.
let nextCustomFamilyId = 0

export function applyTerminalFont(scope: TerminalDocumentScope, font: TerminalCustomFont) {
  const request = ++scope.customFontRequest
  if (!font) {
    releaseCustomFontFace(scope)
    setTerminalFontFamily(scope, defaultTerminalFontFamily())
    return
  }
  if (typeof FontFace !== 'function' || !document.fonts) {
    return
  }
  const family = `Orca Terminal Font ${++nextCustomFamilyId}`
  let face: FontFace
  try {
    face = new FontFace(family, `url(${font.source})`)
  } catch {
    return
  }
  face.load().then(
    () => {
      if (request !== scope.customFontRequest) {
        return
      }
      releaseCustomFontFace(scope)
      document.fonts.add(face)
      scope.customFontFace = face
      // Why: the user's face leads; the default stack still covers glyphs it lacks.
      setTerminalFontFamily(scope, `"${family}", ${defaultTerminalFontFamily()}`)
    },
    () => {}
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

function releaseCustomFontFace(scope: TerminalDocumentScope) {
  const face = scope.customFontFace
  scope.customFontFace = null
  if (face) {
    try {
      document.fonts.delete(face)
    } catch {}
  }
}

export function stopTerminalFont(scope: TerminalDocumentScope) {
  scope.customFontRequest++
  releaseCustomFontFace(scope)
}
