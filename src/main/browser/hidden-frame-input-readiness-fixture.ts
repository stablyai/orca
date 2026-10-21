import type { Locator } from 'playwright'
import { expect } from 'vitest'

const READY_ATTRIBUTE = 'data-hidden-frame-input-ready'

// A new sandboxed iframe runs in its own renderer and can finish loading before the browser routes
// pointer input to it; until then Playwright's click lands on the parent and the frame sees nothing.
export async function waitForHiddenFrameInput(target: Locator): Promise<void> {
  await target.evaluate((element, attribute) => {
    element.removeAttribute(attribute)
    element.addEventListener('pointermove', (event) => {
      if (event.isTrusted) {
        element.setAttribute(attribute, 'true')
      }
    })
  }, READY_ATTRIBUTE)
  await expect
    .poll(
      async () => {
        // Leave first so every hover is a fresh move the browser has to route again.
        await target.page().mouse.move(0, 0)
        await target.hover()
        return target.getAttribute(READY_ATTRIBUTE)
      },
      { timeout: 10_000 }
    )
    .toBe('true')
}
