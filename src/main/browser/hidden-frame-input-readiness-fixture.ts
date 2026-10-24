import type { Locator } from 'playwright'
import { expect } from 'vitest'

const READY_ATTRIBUTE = 'data-hidden-frame-input-ready'

// A sandboxed iframe can finish loading before pointer input reaches its renderer.
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
