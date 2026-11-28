import type { WebContents } from 'electron'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Moves the pointer and returns once the page has received the move. No frame wait: the pick
 * hit-tests at the click's own point (settleHover), and a frame-starved guest under Xvfb can
 * produce no frame for seconds, which made a frame wait flake.
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
}
