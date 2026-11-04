import { useEffect, useState, type ReactNode } from 'react'
import { EdgeNavigationModeSheet } from './EdgeNavigationModeSheet'
import { ScreenEdgeNavigationOverlay } from './ScreenEdgeNavigationOverlay'
import {
  GlobalEdgeNavigationContext,
  useGlobalEdgeNavigation,
  type GlobalEdgeNavigationValue
} from './edge-navigation-state'

export { GlobalEdgeNavigationContext, useGlobalEdgeNavigation, type GlobalEdgeNavigationValue }

export type EdgeDirection = 'up' | 'down' | 'left' | 'right'

export type EdgeNavigationPressHandle = {
  readonly tap: () => void | Promise<unknown>
  readonly hold?: (firstRepeatDelayMs?: number) => void
  readonly stop?: () => void
}

export type EdgeNavigationTarget = {
  readonly id: string
  readonly kind: 'terminal' | 'agent-session' | 'content-window'
  readonly obscured?: boolean
  readonly modifierActive?: boolean
  readonly canNavigate?: (direction: EdgeDirection) => boolean
  readonly preparePress: (
    direction: EdgeDirection,
    paneNode?: unknown
  ) => EdgeNavigationPressHandle
}

const SCROLL_REPEAT_INTERVAL_MS = 140
const DEFAULT_REPEAT_DELAY_MS = 350

function isScrollableOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

export function scrollPaneViewport(
  paneNode: unknown,
  direction: EdgeDirection
): { scrolled: boolean; nearBottom: boolean } {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { scrolled: false, nearBottom: false }
  }
  const vertical = direction === 'up' || direction === 'down'
  const sign = direction === 'up' || direction === 'left' ? -1 : 1
  const hostRoot =
    typeof HTMLElement !== 'undefined' && paneNode instanceof HTMLElement
      ? (paneNode.parentElement ?? paneNode)
      : null

  const pool: HTMLElement[] = []
  if (hostRoot) {
    pool.push(hostRoot)
    pool.push(...Array.from(hostRoot.querySelectorAll<HTMLElement>('div, main, section, pre')))
  } else {
    pool.push(...Array.from(document.querySelectorAll<HTMLElement>('div, main, section, pre')))
  }

  let best: HTMLElement | null = null
  let bestArea = 0
  for (const el of pool) {
    if (el.clientHeight < 48 || el.clientWidth < 80) {
      continue
    }
    const canScrollAxis = vertical
      ? el.scrollHeight > el.clientHeight + 6
      : el.scrollWidth > el.clientWidth + 6
    if (!canScrollAxis) {
      continue
    }
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') {
      continue
    }
    const overflow = vertical ? style.overflowY : style.overflowX
    if (!isScrollableOverflow(overflow)) {
      continue
    }
    if (!vertical) {
      if (sign < 0 && el.scrollLeft <= 2) {
        continue
      }
      if (sign > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 2) {
        continue
      }
    }
    const area = el.clientWidth * el.clientHeight
    if (area >= bestArea) {
      bestArea = area
      best = el
    }
  }

  if (best) {
    if (vertical) {
      const step = Math.max(110, Math.round(best.clientHeight * 0.62))
      const nextTop = Math.max(
        0,
        Math.min(best.scrollHeight - best.clientHeight, best.scrollTop + sign * step)
      )
      best.scrollBy({ top: sign * step, behavior: 'smooth' })
      const nearBottom = best.scrollHeight - (nextTop + best.clientHeight) <= 84
      return { scrolled: true, nearBottom }
    }
    const step = Math.max(96, Math.round(best.clientWidth * 0.55))
    best.scrollBy({ left: sign * step, behavior: 'smooth' })
    return { scrolled: true, nearBottom: false }
  }

  if (
    vertical &&
    document.scrollingElement &&
    document.scrollingElement.scrollHeight > window.innerHeight + 8
  ) {
    const step = Math.max(120, Math.round(window.innerHeight * 0.62))
    window.scrollBy({ top: sign * step, behavior: 'smooth' })
    return { scrolled: true, nearBottom: false }
  }
  return { scrolled: false, nearBottom: false }
}

export function createRepeatingDirectionHandle(
  step: () => void,
  repeatable: boolean
): EdgeNavigationPressHandle {
  let held = false
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null

  const clearTimers = () => {
    if (delayTimer !== null) {
      clearTimeout(delayTimer)
      delayTimer = null
    }
    if (intervalTimer !== null) {
      clearInterval(intervalTimer)
      intervalTimer = null
    }
  }

  return {
    tap: () => {
      if (held) {
        return
      }
      step()
    },
    hold: repeatable
      ? (firstRepeatDelayMs = DEFAULT_REPEAT_DELAY_MS) => {
          clearTimers()
          held = true
          step()
          delayTimer = setTimeout(
            () => {
              delayTimer = null
              intervalTimer = setInterval(() => {
                step()
              }, SCROLL_REPEAT_INTERVAL_MS)
            },
            Math.max(40, firstRepeatDelayMs)
          )
        }
      : undefined,
    stop: () => {
      held = false
      clearTimers()
    }
  }
}

let activeSheetOwnerToken: symbol | null = null

export function PaneEdgeNavigationOverlay(props: {
  target: EdgeNavigationTarget
  bottomInset?: number
}): ReactNode {
  const nav = useGlobalEdgeNavigation()
  const [ownerToken] = useState(() => Symbol('edge-sheet-owner'))

  useEffect(() => {
    if (activeSheetOwnerToken === null) {
      activeSheetOwnerToken = ownerToken
    }
    return () => {
      if (activeSheetOwnerToken === ownerToken) {
        activeSheetOwnerToken = null
      }
    }
  }, [ownerToken])

  const canRenderSheet =
    nav !== null &&
    nav.sheetVisible &&
    (activeSheetOwnerToken === null || activeSheetOwnerToken === ownerToken)

  if (!nav) {
    return null
  }

  return (
    <>
      <ScreenEdgeNavigationOverlay target={props.target} bottomInset={props.bottomInset} />
      {canRenderSheet ? (
        <EdgeNavigationModeSheet
          visible={nav.sheetVisible}
          mode={nav.mode}
          switcherChipHidden={nav.switcherChipHidden}
          onSelectMode={nav.setMode}
          onToggleSwitcherChip={nav.setSwitcherChipHidden}
          onClose={() => nav.setSheetVisible(false)}
        />
      ) : null}
    </>
  )
}
