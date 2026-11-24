// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { createBrowserGuestPickerAuthority } from '../../../preload/browser/element-grab/browser-guest-picker-authority'
import { attachGrabExecutionTransport } from './testing/grab-execution-transport-fixture'
import { executeGrabScript, grabDocumentScope, retireGrabOverlay } from './grab-guest-execution'

afterEach(() => {
  document.body.replaceChildren()
  for (const host of document.querySelectorAll('#__orca-grab-host')) {
    host.remove()
  }
})

// Each arm script adds its own picker host; its private control removes that host on teardown.
// The 'held-replacement' arm runs until `finishHeldArm` is called.
function pickerPage(): {
  guest: Electron.WebContents
  hosts: Map<string, HTMLElement>
  finishHeldArm: () => void
} {
  const hosts = new Map<string, HTMLElement>()
  let finishHeldArm: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    finishHeldArm = resolve
  })
  const authority = createBrowserGuestPickerAuthority(() => true)
  const fixture = attachGrabExecutionTransport(
    Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        if (code === 'held-replacement') {
          await held
        }
        const host = document.createElement('div')
        host.id = '__orca-grab-host'
        document.documentElement.appendChild(host)
        hosts.set(code, host)
        if (code === 'failing-replacement') {
          throw new Error('arm script failed after inserting its host')
        }
        return (action: string) => {
          if (action === 'teardown') {
            host.remove()
          }
          return true
        }
      }
    }),
    authority
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the execution transport and lifetime members above are used.
  return { guest: fixture as unknown as Electron.WebContents, hosts, finishHeldArm }
}

const delivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

it('cancel after a failed replacement arm retires the picker that stayed live', async () => {
  const { guest, hosts } = pickerPage()
  await expect(executeGrabScript(guest, 'first', { overlayControl: true })).resolves.toBe(true)
  await expect(
    executeGrabScript(guest, 'failing-replacement', { overlayControl: true })
  ).resolves.toBeNull()
  expect(hosts.get('first')?.isConnected).toBe(true)

  retireGrabOverlay(grabDocumentScope(guest))
  await delivered()
  expect(hosts.get('first')?.isConnected).toBe(false)
})

it('cancel after a successful replacement arm retires the replacement', async () => {
  const { guest, hosts } = pickerPage()
  await expect(executeGrabScript(guest, 'first', { overlayControl: true })).resolves.toBe(true)
  await expect(executeGrabScript(guest, 'replacement', { overlayControl: true })).resolves.toBe(
    true
  )
  // The page swapped pickers: the replacement is the live one.
  expect(hosts.get('first')?.isConnected).toBe(false)
  expect(hosts.get('replacement')?.isConnected).toBe(true)

  retireGrabOverlay(grabDocumentScope(guest))
  await delivered()
  expect(hosts.get('replacement')?.isConnected).toBe(false)
})

it('cancel while a replacement arm is still running retires both pickers', async () => {
  const { guest, hosts, finishHeldArm } = pickerPage()
  await expect(executeGrabScript(guest, 'first', { overlayControl: true })).resolves.toBe(true)
  const replacement = executeGrabScript(guest, 'held-replacement', { overlayControl: true })
  // The page has started the arm and it has not reported yet: cancel now.
  const scope = grabDocumentScope(guest)
  await delivered()
  expect(scope.pendingOverlayId).not.toBeNull()
  retireGrabOverlay(scope)
  await delivered()
  expect(hosts.get('first')?.isConnected).toBe(false)

  finishHeldArm()
  await expect(replacement).resolves.toBe(false)
  await delivered()
  expect(hosts.get('held-replacement')?.isConnected).toBe(false)
})
