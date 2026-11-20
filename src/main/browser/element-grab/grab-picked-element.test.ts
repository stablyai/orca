import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { BROWSER_GRAB_SELECTED_ATTRIBUTE } from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'
import { isPickedElementPresent, retainPickedElement } from './grab-picked-element'
import { attachGrabExecutionTransport } from './testing/grab-execution-transport-fixture'
import { GRAB_PICK_CONTROL_SCRIPT } from './grab-guest-pick-control-script'
import { clampGrabPayload } from './browser-grab-payload'
import { executeGrabScript, requestGrabExecution } from './grab-guest-execution'

it('keeps the original picked node across marker removal and rejects replacement or document adoption', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    const document = window.document
    const original = document.createElement('button')
    original.id = 'target'
    original.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'pick-1')
    document.body.append(original)
    const pick = runInNewContext(
      `${GRAB_PICK_CONTROL_SCRIPT};pickControl(original, payload, false)`,
      {
        document,
        window,
        original,
        host: document.createElement('div'),
        payload: { page: { capturedAt: 'synthetic' }, target: { tagName: 'button' } }
      }
    )
    let release: ((value: boolean) => void) | undefined
    const pending = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const guestFixture = attachGrabExecutionTransport(
      Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        executeJavaScript: (code: string) => (code === 'pick' ? Promise.resolve(pick) : pending)
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the implemented execution and lifetime methods are used.
    const guest = guestFixture as unknown as Electron.WebContents
    const execution = await requestGrabExecution(guest, 'pick', { capturePick: 'held' })
    const payload = execution.ok ? clampGrabPayload(execution.value) : null
    const id = payload?.page.selectionId
    if (!id) {
      throw new Error('Missing private selection identity')
    }
    await expect(retainPickedElement(guest, id)).resolves.toBe(true)
    const busy = executeGrabScript(guest, 'true')
    await expect(isPickedElementPresent(guest, id)).resolves.toBeNull()
    release?.(true)
    await expect(busy).resolves.toBe(true)
    original.removeAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE)
    await expect(isPickedElementPresent(guest, id)).resolves.toBe(true)
    const replacement = document.createElement('button')
    replacement.id = 'target'
    replacement.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'pick-1')
    original.replaceWith(replacement)
    await expect(isPickedElementPresent(guest, id)).resolves.toBe(false)
    await expect(isPickedElementPresent(guest, 'another-pick')).resolves.toBe(false)
    const otherDocument = document.implementation.createHTMLDocument()
    otherDocument.body.append(otherDocument.adoptNode(original))
    await expect(isPickedElementPresent(guest, id)).resolves.toBe(false)
  } finally {
    await window.happyDOM.abort()
  }
})
