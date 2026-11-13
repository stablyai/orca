import { useLayoutEffect, useState, useSyncExternalStore } from 'react'

/** 0 = full chrome; 1 = "Orca" word and Forward fold; 2 = Back and "+" move into the pane ⋯. */
export type TitlebarChromeFoldLevel = 0 | 1 | 2

/** Strip widths (the owner pane's tab-strip container beside the floating header). */
export const CHROME_FOLD_STEP1_BELOW_PX = 330
export const CHROME_FOLD_STEP2_BELOW_PX = 190
export const CHROME_FOLD_HYSTERESIS_PX = 8

/**
 * Each input is the strip width the owner pane would get with the header at that level, so the
 * decision never feeds back into itself. Unfolding needs the threshold plus hysteresis, and a
 * fresh reading inside the deadband starts unfolded.
 */
export function resolveTitlebarChromeFoldLevel({
  previous,
  stripWidthAtLevel0,
  stripWidthAtLevel1
}: {
  previous: TitlebarChromeFoldLevel
  stripWidthAtLevel0: number
  stripWidthAtLevel1: number
}): TitlebarChromeFoldLevel {
  const unfoldTo0 = CHROME_FOLD_STEP1_BELOW_PX + (previous > 0 ? CHROME_FOLD_HYSTERESIS_PX : 0)
  if (stripWidthAtLevel0 >= unfoldTo0) {
    return 0
  }
  const unfoldTo1 = CHROME_FOLD_STEP2_BELOW_PX + (previous > 1 ? CHROME_FOLD_HYSTERESIS_PX : 0)
  return stripWidthAtLevel1 >= unfoldTo1 ? 1 : 2
}

/**
 * Fold decision from live measurements. Deeper levels are measured from the header's visible
 * foldable parts; shallower ones only from a cached measurement taken at that level. With no
 * measurement the level holds (no estimates), so the header can't oscillate on a guess.
 */
export function decideTitlebarChromeFold({
  previous,
  stripWidth,
  headerWidth,
  foldableWidthTo,
  cachedHeaderWidths
}: {
  previous: TitlebarChromeFoldLevel
  /** The owner strip's width with the header as it is now. */
  stripWidth: number
  headerWidth: number
  /** Width the current header loses folding down to a deeper level. */
  foldableWidthTo: (level: TitlebarChromeFoldLevel) => number
  cachedHeaderWidths: Partial<Record<TitlebarChromeFoldLevel, number>>
}): TitlebarChromeFoldLevel {
  const stripWidthAt = (level: TitlebarChromeFoldLevel): number => {
    if (level >= previous) {
      return stripWidth + foldableWidthTo(level)
    }
    const cached = cachedHeaderWidths[level]
    return cached === undefined ? Number.NEGATIVE_INFINITY : stripWidth + headerWidth - cached
  }
  return resolveTitlebarChromeFoldLevel({
    previous,
    stripWidthAtLevel0: stripWidthAt(0),
    stripWidthAtLevel1: stripWidthAt(1)
  })
}

// Layout-only state with one writer (the app shell's observer); not persisted, so not a store slice.
let foldLevel: TitlebarChromeFoldLevel = 0
let ownerStrip: HTMLElement | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setTitlebarChromeFoldLevel(level: TitlebarChromeFoldLevel): void {
  if (level !== foldLevel) {
    foldLevel = level
    emit()
  }
}

export function getTitlebarChromeFoldLevel(): TitlebarChromeFoldLevel {
  return foldLevel
}

export function useTitlebarChromeFoldLevel(): TitlebarChromeFoldLevel {
  return useSyncExternalStore(subscribe, getTitlebarChromeFoldLevel, getTitlebarChromeFoldLevel)
}

/** The top-left pane's visible attached strip registers itself; only the latest owner can clear it. */
export function registerTitlebarChromeOwnerStrip(element: HTMLElement): () => void {
  ownerStrip = element
  emit()
  return () => {
    if (ownerStrip === element) {
      ownerStrip = null
      emit()
    }
  }
}

function getOwnerStrip(): HTMLElement | null {
  return ownerStrip
}

export function useTitlebarChromeOwnerStrip(): HTMLElement | null {
  return useSyncExternalStore(subscribe, getOwnerStrip, getOwnerStrip)
}

/**
 * For a tab group's strip: registers it as the owner while it is the visible top-left attached
 * strip beside the floating header, and returns the fold level that applies to it (0 otherwise).
 * Registration runs in an effect so committed visibility and split changes re-run it.
 */
export function useTitlebarChromeOwnerFold(isOwner: boolean): {
  foldLevel: TitlebarChromeFoldLevel
  setOwnerStripElement: (element: HTMLDivElement | null) => void
} {
  const storedLevel = useTitlebarChromeFoldLevel()
  const [element, setOwnerStripElement] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(
    () => (isOwner && element ? registerTitlebarChromeOwnerStrip(element) : undefined),
    [isOwner, element]
  )
  return { foldLevel: isOwner ? storedLevel : 0, setOwnerStripElement }
}
