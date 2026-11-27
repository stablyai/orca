import type { WebContents } from 'electron'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Presses a key in the page and returns once it has gone somewhere. Each key in these fixtures
 * either reaches the page (`window.__pageKeys`) or is forwarded to the palette (`forwarded`); a
 * fixed delay alone can read where it went before a loaded machine delivers it.
 */
export function createFixtureKeyPress(page: WebContents, forwarded: readonly string[]) {
  const pageKeyCount = async (): Promise<number> =>
    Number(await page.executeJavaScript('(window.__pageKeys || []).length'))
  return async (key: string): Promise<void> => {
    const pageBefore = await pageKeyCount()
    const forwardedBefore = forwarded.length
    page.sendInputEvent({ type: 'keyDown', keyCode: key })
    page.sendInputEvent({ type: 'char', keyCode: key })
    page.sendInputEvent({ type: 'keyUp', keyCode: key })
    const deadline = Date.now() + 2_000
    while (forwarded.length === forwardedBefore && (await pageKeyCount()) === pageBefore) {
      if (Date.now() > deadline) {
        break
      }
      await wait(20)
    }
    await wait(80)
  }
}
