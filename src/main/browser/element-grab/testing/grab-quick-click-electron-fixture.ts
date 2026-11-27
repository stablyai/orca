import type { WebContents } from 'electron'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'

/** A click right after a move, before the outline's frame, must still pick what the press hit. */
export async function verifyGrabQuickClick(page: WebContents, manager: BrowserManager) {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const evalPage = (code: string): Promise<unknown> => page.executeJavaScript(code)
  const buyCenter = (axis: 'x' | 'y'): Promise<number> =>
    evalPage(
      `(() => { const r = document.getElementById('buy').getBoundingClientRect(); return Math.round(r.${axis} + r.${axis === 'x' ? 'width' : 'height'} / 2) })()`
    ).then(Number)
  const buy = { x: await buyCenter('x'), y: await buyCenter('y') }
  // Rest the pointer off any element, so a frame-old outline names nothing at the click.
  page.sendInputEvent({ type: 'mouseMove', x: 400, y: 500 })
  await wait(100)
  const selection = manager.awaitGrabSelection('page-1', 'quick-click', page)
  const deadline = Date.now() + 10_000
  while (
    !(await evalPage(
      "Boolean(document.getElementById('__orca-grab-host')?.hasAttribute('data-orca-grab-awaiting'))"
    ))
  ) {
    if (Date.now() > deadline) {
      throw new Error('Quick-click selection did not start')
    }
    await wait(20)
  }
  // Hold the page's animation frames, so the outline cannot catch up to the move before the click.
  await evalPage(
    'window.__heldFrames = []; window.__realFrame = window.requestAnimationFrame; window.requestAnimationFrame = (frame) => window.__heldFrames.push(frame); true'
  )
  page.sendInputEvent({ type: 'mouseMove', x: buy.x, y: buy.y })
  page.sendInputEvent({ type: 'mouseDown', x: buy.x, y: buy.y, button: 'left', clickCount: 1 })
  page.sendInputEvent({ type: 'mouseUp', x: buy.x, y: buy.y, button: 'left', clickCount: 1 })
  const result = await selection
  const heldFrames = Number(
    await evalPage(
      'window.requestAnimationFrame = window.__realFrame; const held = window.__heldFrames.splice(0); held.forEach((frame) => frame(performance.now())); held.length'
    )
  )
  return {
    // At least the move's frame was held: the click really came before the outline caught up.
    framesHeld: heldFrames > 0,
    kind: result.kind,
    target: result.kind === 'selected' ? result.payload.target.tagName : null
  }
}
