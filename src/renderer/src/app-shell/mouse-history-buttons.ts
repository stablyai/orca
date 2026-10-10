import { isInsideBrowserPageSurface } from '@/lib/browser-page-surface'
import { readSideButtonTransition } from '@/lib/side-button-transition'

export type MouseHistoryAction = 'worktree.history.back' | 'worktree.history.forward'

const MOUSE_HISTORY_ACTIONS = {
  3: 'worktree.history.back',
  4: 'worktree.history.forward'
} as const satisfies Record<3 | 4, MouseHistoryAction>

/** Routes mouse Back/Forward to worktree history; act on release so one press moves one step. */
export function installMouseHistoryButtons(
  target: Window,
  runHistoryAction: (action: MouseHistoryAction) => void
): () => void {
  // Why: a press that starts on page content belongs to the page even if released over Orca chrome.
  const pressStartedOnPage = new Map<number, boolean>()

  // Why pointer events: an element that cancels pointerdown (dividers, the remote frame) suppresses
  // the compat mouse events, which would let Blink's default navigate the document unchecked. For
  // the same reason defaultPrevented is not an opt-out here.
  const onPointerButton = (event: PointerEvent): void => {
    const transition = readSideButtonTransition(event)
    if (!transition) {
      return
    }
    const onPage = isInsideBrowserPageSurface(event.target)
    // Why: Blink's default for these buttons navigates the document itself — Orca's renderer, or
    // the web client's browser tab. Cancel even over web pages so a leaked guest press can't.
    event.preventDefault()
    if (transition.phase === 'press') {
      pressStartedOnPage.set(transition.button, onPage)
      return
    }
    const startedOnPage = pressStartedOnPage.get(transition.button) ?? onPage
    pressStartedOnPage.delete(transition.button)
    if (!startedOnPage && !onPage) {
      runHistoryAction(MOUSE_HISTORY_ACTIONS[transition.button])
    }
  }
  // Why: a chorded press only cancels its pointermove, which does not suppress the compat mouseup
  // that carries Blink's default history navigation.
  const cancelSideButtonMouseUp = (event: MouseEvent): void => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault()
    }
  }
  const forgetPresses = (): void => pressStartedOnPage.clear()

  target.addEventListener('pointerdown', onPointerButton, { capture: true })
  target.addEventListener('pointermove', onPointerButton, { capture: true })
  target.addEventListener('pointerup', onPointerButton, { capture: true })
  target.addEventListener('mouseup', cancelSideButtonMouseUp, { capture: true })
  target.addEventListener('blur', forgetPresses)
  return () => {
    target.removeEventListener('pointerdown', onPointerButton, { capture: true })
    target.removeEventListener('pointermove', onPointerButton, { capture: true })
    target.removeEventListener('pointerup', onPointerButton, { capture: true })
    target.removeEventListener('mouseup', cancelSideButtonMouseUp, { capture: true })
    target.removeEventListener('blur', forgetPresses)
  }
}
