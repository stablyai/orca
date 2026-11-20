import type { WebContents } from 'electron'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'

/** Real private function handoff and capture; all bytes stay in memory on this synthetic page. */
export async function verifyGrabPickLifetime(
  page: WebContents,
  manager: BrowserManager,
  pageHtml: string
) {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const pick = async (replaceDuringHandoff: boolean) => {
    if (!(await manager.setGrabMode('page-1', true, page))) {
      throw new Error('Pick not armed')
    }
    if (replaceDuringHandoff) {
      await page.executeJavaScript(`(() => {
        const grab = window.__orcaGrab; const freeze = grab.freezeHighlight;
        grab.freezeHighlight = function(id) {
          freeze(id); const original = document.getElementById('target'); original.replaceWith(original.cloneNode(true));
        }; return true;
      })()`)
    }
    const result = manager.awaitGrabSelection('page-1', 'original-lifetime', page)
    const deadline = Date.now() + 5_000
    while (!(await page.executeJavaScript('Boolean(window.__orcaGrab?.cancelAwait)'))) {
      if (Date.now() > deadline) {
        throw new Error('Selection did not start')
      }
      await wait(20)
    }
    page.sendInputEvent({ type: 'mouseMove', x: 280, y: 180 })
    await wait(80)
    page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: 280, y: 180 })
    page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 280, y: 180 })
    return result
  }
  const handoff = await pick(true)
  await manager.setGrabMode('page-1', false, page)
  await page.loadURL(`data:text/html,${encodeURIComponent(pageHtml)}`)
  const selected = await pick(false)
  if (selected.kind !== 'selected' || !selected.payload.page.selectionId) {
    throw new Error('Original not selected')
  }
  const id = selected.payload.page.selectionId
  await page.executeJavaScript("history.pushState(null, '', '#same-document'); true")
  const heldAfterRoute = await manager.isGrabPickedElementPresent(id, page, true)
  const screenshot = await manager.captureSelectionScreenshot(
    'page-1',
    selected.payload.target.rectViewport,
    id,
    page
  )
  await page.executeJavaScript(
    "(() => {const original = document.getElementById('target'); original.replaceWith(original.cloneNode(true)); return true})()"
  )
  const presentAfterReplacement = await manager.isGrabPickedElementPresent(id, page, true)
  const replacedScreenshot = await manager.captureSelectionScreenshot(
    'page-1',
    selected.payload.target.rectViewport,
    id,
    page
  )
  await manager.setGrabMode('page-1', false, page)
  await page.loadURL(`data:text/html,${encodeURIComponent(pageHtml)}`)
  return {
    handoff: handoff.kind,
    heldAfterRoute,
    screenshotBeforeReplacement: Boolean(screenshot),
    presentAfterReplacement,
    screenshotAfterReplacement: Boolean(replacedScreenshot)
  }
}
