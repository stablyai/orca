import { isTerminalWaitWhitespace } from './terminal-wait-tail-window'

/**
 * Antigravity paints its chrome with cursor addressing, so model/account rows are not stable
 * line anchors. The idle composer is the only captured marker that survives every ready screen.
 */
export function findAntigravityReadyPromptIndex(normalized: string): number | null {
  return findAntigravityComposerIndex(normalized, true)
}

/** Visible-screen snapshots may omit the banner after a dialog closes. */
export function isAntigravityReadyPromptSnapshot(text: string): boolean {
  return findAntigravityComposerIndex(text.toLowerCase(), false) !== null
}

function findAntigravityComposerIndex(normalized: string, requireHeader: boolean): number | null {
  const headerIndex = normalized.lastIndexOf('antigravity cli')
  const contentStart = headerIndex === -1 ? 0 : headerIndex
  if (requireHeader && headerIndex === -1) {
    return null
  }

  let offset = 0
  let composerStart: number | null = null
  let composerEnd = 0
  for (const line of normalized.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + line.length
    let trimmedStart = lineStart
    let trimmedEnd = lineEnd
    while (trimmedStart < trimmedEnd && isTerminalWaitWhitespace(normalized, trimmedStart)) {
      trimmedStart += 1
    }
    while (trimmedEnd > trimmedStart && isTerminalWaitWhitespace(normalized, trimmedEnd - 1)) {
      trimmedEnd -= 1
    }
    if (trimmedStart >= contentStart && trimmedEnd - trimmedStart === 1) {
      if (normalized.charCodeAt(trimmedStart) === 62) {
        composerStart = trimmedStart
        composerEnd = trimmedEnd
      }
    }
    offset = lineEnd + 1
  }
  if (composerStart === null) {
    return null
  }
  const suffix = normalized.slice(composerEnd)
  const currentScreen = normalized.slice(contentStart)
  // A trailing caret also appears on trust, sign-in, model, and onboarding menus. Those panes
  // must remain blocked until the menu is gone; only the latest AGY screen can establish readiness.
  if (
    /do you trust|sign in|select a model|collect usage|choose a theme|press enter to continue|\b[12]\.\s/.test(
      currentScreen
    )
  ) {
    return null
  }
  return suffix.trim().length === 0 || /resume with -c|agy --conversation/i.test(suffix)
    ? composerStart
    : null
}

export function hasAntigravityTerminalHeader(text: string): boolean {
  return text.toLowerCase().includes('antigravity cli')
}
