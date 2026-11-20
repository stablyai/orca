import type { WebContents } from 'electron'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'

export async function verifyGrabSelectionReplacement(
  page: WebContents,
  manager: BrowserManager,
  forwarded: string[],
  press: (key: string) => Promise<void>
) {
  const deadline = Date.now() + 10_000
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const evalPage = (code: string): Promise<unknown> => page.executeJavaScript(code)
  await evalPage("document.getElementById('buy').focus();window.__pageKeys=[]")
  const oldPick = manager.awaitGrabSelection('page-1', 'replaced-pick', page)
  while (!(await evalPage('Boolean(window.__orcaGrab?.cancelAwait)'))) {
    if (Date.now() > deadline) {
      throw new Error('First selection did not start')
    }
    await wait(20)
  }
  await evalPage('window.__priorAwait = window.__orcaGrab.cancelAwait;true')
  const newPick = manager.awaitGrabSelection('page-1', 'replacement-pick', page)
  const oldResult = await oldPick
  while (
    !(await evalPage(
      'Boolean(window.__orcaGrab?.cancelAwait && window.__orcaGrab.cancelAwait !== window.__priorAwait)'
    ))
  ) {
    if (Date.now() > deadline) {
      throw new Error('Replacement selection did not start')
    }
    await wait(20)
  }
  const target = await page.executeJavaScript(
    "(() => {const r=document.getElementById('buy').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"
  )
  page.sendInputEvent({ type: 'mouseMove', ...target })
  await wait(80)
  page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...target })
  page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target })
  const newResult = await newPick
  const beforeConfirming = forwarded.length
  await evalPage('window.__pageKeys=[]')
  await press('g')
  const replacement = {
    oldKind: oldResult.kind,
    newKind: newResult.kind,
    forwarded: forwarded.slice(beforeConfirming),
    pageSawKey: await evalPage("window.__pageKeys.includes('g')")
  }
  return replacement
}
