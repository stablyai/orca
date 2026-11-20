import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { BROWSER_GRAB_SELECTED_ATTRIBUTE } from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'
import { isPickedElementPresent, retainPickedElement } from './grab-picked-element'

it('keeps the original picked node across marker removal and rejects a same-selector replacement', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    const document = window.document
    const original = document.createElement('button')
    original.id = 'target'
    original.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'pick-1')
    document.body.append(original)
    const world = { document, globalThis: {} }
    const guestFixture = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: async (_id: number, scripts: { code: string }[]) =>
        runInNewContext(scripts[0]?.code ?? '', world)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the implemented execution and lifetime methods are used.
    const guest = guestFixture as unknown as Electron.WebContents
    await expect(retainPickedElement(guest, 'pick-1')).resolves.toBe(true)
    original.removeAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE)
    await expect(isPickedElementPresent(guest, 'pick-1')).resolves.toBe(true)
    const replacement = document.createElement('button')
    replacement.id = 'target'
    replacement.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'pick-1')
    original.replaceWith(replacement)
    await expect(isPickedElementPresent(guest, 'pick-1')).resolves.toBe(false)
    await expect(isPickedElementPresent(guest, 'another-pick')).resolves.toBe(false)
  } finally {
    await window.happyDOM.abort()
  }
})
