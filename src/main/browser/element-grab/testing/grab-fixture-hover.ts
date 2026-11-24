import type { WebContents } from 'electron'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Moves the pointer and returns once the picker has hovered the element under it. The picker
 * records the hovered element on the frame after a move, so a click sent a fixed delay later can
 * arrive first on a loaded machine and cancel the pick instead of selecting.
 */
export async function hoverForPick(page: WebContents, point: { x: number; y: number }) {
  const before: number = await page.executeJavaScript(`(() => {
    if (window.__fixtureMoves === undefined) {
      window.__fixtureMoves = 0;
      addEventListener('mousemove', () => { window.__fixtureMoves++ }, true);
    }
    return window.__fixtureMoves;
  })()`)
  page.sendInputEvent({ type: 'mouseMove', ...point })
  const deadline = Date.now() + 5_000
  while ((await page.executeJavaScript('window.__fixtureMoves')) <= before) {
    if (Date.now() > deadline) {
      throw new Error('The pointer move never reached the page')
    }
    await wait(20)
  }
  // The picker's listener ran first and queued its hover for the next frame; two frames cover it.
  // Bounded, since a hidden window that is throttled may produce no frames at all.
  await page.executeJavaScript(`new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(true) }));
  })`)
}
