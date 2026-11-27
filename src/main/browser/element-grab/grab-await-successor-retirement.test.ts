import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ webContents: { fromId: () => null } }))

const { attachGrabExecutionTransport } = await import('./testing/grab-execution-transport-fixture')
const { executeGrabScript } = await import('./grab-guest-execution')
const { BrowserGrabSessionController } = await import('./browser-grab-session-controller')

/** Each arm script returns its own picker control; tearing a picker down ends a wait running on it. */
function pickerPage() {
  const tornDown: string[] = []
  const guest = attachGrabExecutionTransport(
    Object.assign(new EventEmitter(), {
      id: 3,
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        let endWait: (value: unknown) => void = () => {}
        return (action: string) => {
          if (action === 'awaitClick') {
            return new Promise((resolve) => {
              endWait = resolve
            })
          }
          if (action === 'teardown') {
            tornDown.push(code)
            endWait({ __orcaCancelled: true })
          }
          return true
        }
      }
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller and execution lane use only the transport, id, isDestroyed and events above.
  return { guest: guest as unknown as Electron.WebContents, tornDown }
}

it("a wait ended by its picker's replacement leaves the replacement picker live", async () => {
  const { guest, tornDown } = pickerPage()
  await expect(executeGrabScript(guest, 'first', { overlayControl: true })).resolves.toBe(true)
  const wait = new BrowserGrabSessionController().awaitGrabSelection('page', 'op', guest)
  await new Promise((resolve) => setTimeout(resolve, 0))

  // The renderer rearms while the wait is outstanding; the page swaps pickers and the old wait ends.
  await expect(executeGrabScript(guest, 'replacement', { overlayControl: true })).resolves.toBe(
    true
  )
  await expect(wait).resolves.toMatchObject({ kind: 'cancelled' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(tornDown).toEqual(['first'])
})
