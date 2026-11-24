// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { BROWSER_GRAB_SELECTED_ATTRIBUTE } from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'
import { createBrowserGuestPickerAuthority } from '../../../preload/browser/element-grab/browser-guest-picker-authority'
import { attachGrabExecutionTransport } from './testing/grab-execution-transport-fixture'
import { executeGrabScript, requestGrabExecution } from './grab-guest-execution'
import { isPickedElementPresent } from './grab-picked-element'

// The page world's verdicts below are forged on purpose: before this fix the page could substitute the
// picker's cleanup and pick control through its global, so only the preload's own references count.
afterEach(() => {
  document.body.replaceChildren()
  for (const host of document.querySelectorAll('#__orca-grab-host')) {
    host.remove()
  }
})

function guestWith(executeJavaScript: (code: string) => Promise<unknown>) {
  // Synthetic events stand in for the user's trusted pointer; layout is stubbed below.
  const authority = createBrowserGuestPickerAuthority(() => true)
  const fixture = attachGrabExecutionTransport(
    Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript }),
    authority
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the execution transport and lifetime members above are used.
  return fixture as unknown as Electron.WebContents
}

it('reports a clean page only when the overlay host it armed is really gone, whatever the page claims', async () => {
  const hosts: HTMLElement[] = []
  const guest = guestWith(async (code) => {
    if (code === 'arm') {
      const host = document.createElement('div')
      host.id = '__orca-grab-host'
      document.documentElement.appendChild(host)
      hosts.push(host)
      // A page-substituted cleanup: claims success and leaves the overlay in place.
      return () => true
    }
    return true
  })
  await expect(executeGrabScript(guest, 'arm', { overlayControl: true })).resolves.toBe(true)
  await expect(executeGrabScript(guest, '', { clean: true })).resolves.toBe(false)

  hosts[0]?.remove()
  await expect(executeGrabScript(guest, '', { clean: true })).resolves.toBe(true)
})

it('keeps a clean negative after a failed arm until every overlay host it left is really gone', async () => {
  const hosts: HTMLElement[] = []
  const addHost = (parent: Element): HTMLElement => {
    const host = document.createElement('div')
    host.id = '__orca-grab-host'
    parent.appendChild(host)
    hosts.push(host)
    return host
  }
  const guest = guestWith(async (code) => {
    if (code === 'ambiguous') {
      // Two hosts: the arm cannot tell which one is the picker's, so it fails.
      addHost(document.documentElement)
      addHost(document.documentElement)
      return () => true
    }
    if (code === 'throws') {
      addHost(document.body)
      throw new Error('arm script failed after inserting its host')
    }
    if (code === 'unrecognizable') {
      // The host arrives inside a wrapper, so no added node is recognizably the picker's host.
      const wrapper = document.createElement('div')
      addHost(wrapper)
      document.body.appendChild(wrapper)
      return () => true
    }
    return true
  })

  await expect(executeGrabScript(guest, 'ambiguous', { overlayControl: true })).resolves.toBe(false)
  // The page puts a host back after the failed arm's cleanup; its teardown claimed success.
  document.documentElement.appendChild(hosts[1])
  await expect(executeGrabScript(guest, '', { clean: true })).resolves.toBe(false)
  hosts[1].remove()
  await expect(executeGrabScript(guest, '', { clean: true })).resolves.toBe(true)

  await expect(executeGrabScript(guest, 'throws', { overlayControl: true })).resolves.toBeNull()
  document.body.appendChild(hosts[2])
  await expect(executeGrabScript(guest, '', { clean: true })).resolves.toBe(false)
  hosts[2].remove()

  await expect(executeGrabScript(guest, 'unrecognizable', { overlayControl: true })).resolves.toBe(
    false
  )
  await expect(executeGrabScript(guest, '', { clean: true })).resolves.toBe(false)
  hosts[3].remove()
  await expect(executeGrabScript(guest, '', { clean: true })).resolves.toBe(true)
})

it('keeps presence tied to the originally picked node and refuses a pick the trusted pointer did not hit', async () => {
  const original = document.createElement('button')
  original.id = 'target'
  original.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'picked-at')
  const decoy = document.createElement('button')
  document.body.append(original, decoy)
  let underPointer: Element = original
  document.elementFromPoint = () => underPointer
  // A page-substituted pick control: always claims its element is still present.
  const forged = (action: string): unknown =>
    action === 'payload'
      ? { payload: { page: { capturedAt: 'picked-at' }, target: { tagName: 'button' } } }
      : true
  const guest = guestWith(async () => forged)
  window.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5 }))

  const picked = await requestGrabExecution(guest, 'pick', { capturePick: 'held' })
  const page =
    picked.ok && picked.value && typeof picked.value === 'object' && 'page' in picked.value
      ? picked.value.page
      : null
  const selectionId =
    page &&
    typeof page === 'object' &&
    'selectionId' in page &&
    typeof page.selectionId === 'string'
      ? page.selectionId
      : undefined
  if (!selectionId) {
    throw new Error('The original pick was not accepted')
  }
  await expect(isPickedElementPresent(guest, selectionId, true)).resolves.toBe(true)
  const clone = original.cloneNode(true)
  original.replaceWith(clone)
  await expect(isPickedElementPresent(guest, selectionId, true)).resolves.toBe(false)

  underPointer = decoy
  window.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5 }))
  await expect(requestGrabExecution(guest, 'pick', { capturePick: 'held' })).resolves.toEqual({
    ok: true,
    value: { __orcaCancelled: true }
  })
})
