import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { selectRailPageHidesWorkspaceList } from '@/components/app-rail/app-rail-layout'
import { takeRailPageListFocusLoss } from '@/components/app-rail/rail-page-list-focus-loss'
import { subscribeOverlayCloses } from '@/lib/overlay-interaction/overlay-focus-ownership'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'

// Lazy pages can take a moment to load; Automations uses the same budget for its own focus.
const RECOVERY_BUDGET_MS = 5000
// The palette restores its focus in a double animation frame; look only after that.
const MIN_FRAMES_BEFORE_RECOVERY = 3
// A page's own focus target, used before its first control.
const DECLARED_PAGE_FOCUS_TARGET = '[data-automations-page-title], [data-automations-page-search]'
const TABBABLE = 'button, [href], input, select, textarea, [tabindex]'

function isUsable(element: HTMLElement): boolean {
  return (
    !element.closest('[inert]') &&
    !element.matches(':disabled') &&
    element.getClientRects().length > 0
  )
}

function resolvePageFocusTarget(column: HTMLElement): HTMLElement | null {
  const declared = column.querySelector<HTMLElement>(DECLARED_PAGE_FOCUS_TARGET)
  if (declared && isUsable(declared)) {
    return declared
  }
  for (const element of column.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (element.tabIndex >= 0 && isUsable(element)) {
      return element
    }
  }
  return null
}

// A rendered page with nothing focusable gets this many frames to settle before focus falls back to the page itself.
const SETTLED_FRAMES_BEFORE_FALLBACK = 10

/** The page column holds the (inert, hidden) terminal workbench plus the active page; true once the page rendered. */
function hasRenderedPage(column: HTMLElement): boolean {
  for (const child of column.children) {
    if (!child.closest('[inert]') && child.childElementCount > 0) {
      return true
    }
  }
  return false
}

function focusPageColumn(column: HTMLElement): void {
  // A page with nothing focusable: hold focus on the page itself rather than the body, only while it has it.
  column.tabIndex = -1
  column.setAttribute('aria-label', translate('appRail.pageRegion', 'Page'))
  const release = (): void => {
    column.removeAttribute('tabindex')
    column.removeAttribute('aria-label')
  }
  column.addEventListener('blur', release, { once: true })
  column.focus({ preventScroll: true })
}

/**
 * With the rail on, a rail page can leave keyboard focus on the body: its open removed the focused list row before the
 * (lazy) page had any control, or an overlay that held focus closed back to a node that is gone. Move focus into the page once it has
 * mounted. Anything that takes focus meanwhile wins, and nothing moves while an overlay is open. Automations moves
 * focus to its own title on open, so only the overlay case applies there.
 */
export function useRailPageFocusRecovery(pageColumnRef: React.RefObject<HTMLElement | null>): void {
  const railPage = useAppStore((s) => (selectRailPageHidesWorkspaceList(s) ? s.activeView : null))
  useEffect(() => {
    const lostFromList = takeRailPageListFocusLoss()
    if (!railPage) {
      return
    }
    let frame = 0
    let deadline = 0
    let frames = 0
    let settledFrames = 0
    const disarm = (): void => {
      deadline = 0
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
    }
    const tick = (): void => {
      frame = 0
      if (!deadline) {
        return
      }
      const active = document.activeElement
      if ((active && active !== document.body) || performance.now() > deadline) {
        disarm()
        return
      }
      frames += 1
      const column = pageColumnRef.current
      if (frames >= MIN_FRAMES_BEFORE_RECOVERY && column && !hasVisibleOverlay()) {
        const target = resolvePageFocusTarget(column)
        if (target) {
          disarm()
          target.focus({ preventScroll: true })
          return
        }
        // Why: a lazy page renders nothing until its chunk loads; fall back to the page itself only once it has
        // rendered and still offers no control, never while it is loading.
        if (hasRenderedPage(column)) {
          settledFrames += 1
          if (settledFrames >= SETTLED_FRAMES_BEFORE_FALLBACK) {
            disarm()
            focusPageColumn(column)
            return
          }
        }
      }
      frame = requestAnimationFrame(tick)
    }
    const arm = (): void => {
      deadline = performance.now() + RECOVERY_BUDGET_MS
      frames = 0
      settledFrames = 0
      if (!frame) {
        frame = requestAnimationFrame(tick)
      }
    }
    // The last element that took focus, so a close can tell whether focus was inside the closed overlay.
    let lastFocused: Element | null = document.activeElement
    // Any focus that lands meanwhile, from the user, a page or a modal, ends this attempt.
    const onFocusIn = (event: FocusEvent): void => {
      lastFocused = event.target instanceof Element ? event.target : null
      disarm()
    }
    document.addEventListener('focusin', onFocusIn, true)
    // Only a real close of an overlay that held focus can strand it; DOM churn and opens never arm this. A submenu is
    // portaled apart from its menu, so its focused item counts too: it left the DOM with the close.
    const unsubscribe = subscribeOverlayCloses((owner) => {
      if (owner && lastFocused && (owner.contains(lastFocused) || !lastFocused.isConnected)) {
        arm()
      }
    })
    if (lostFromList && railPage !== 'automations') {
      arm()
    }
    return () => {
      disarm()
      unsubscribe()
      document.removeEventListener('focusin', onFocusIn, true)
    }
  }, [pageColumnRef, railPage])
}
