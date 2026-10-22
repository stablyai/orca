import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
  webContents: { fromId: vi.fn() }
}))

import { isAgentInjectingInput, withAgentInputInjection } from './agent-input-injection'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'
import { setupGrabShortcutForwarding } from './browser-guest-grab-shortcuts'

type BeforeInputHandler = (event: Electron.Event, input: Electron.Input) => void

function fakeGuest() {
  const handlers: BeforeInputHandler[] = []
  const guest = {
    on: vi.fn((event: string, handler: BeforeInputHandler) => {
      if (event === 'before-input-event') {
        handlers.push(handler)
      }
    }),
    off: vi.fn(),
    isDestroyed: vi.fn(() => false),
    setIgnoreMenuShortcuts: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member these functions call.
  const webContents = guest as unknown as Electron.WebContents
  const press = (input: Partial<Electron.Input>): ReturnType<typeof vi.fn> => {
    const preventDefault = vi.fn()
    for (const handler of handlers) {
      handler(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers only call preventDefault.
        { preventDefault } as unknown as Electron.Event,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers read only the fields set here.
        {
          type: 'keyDown',
          alt: false,
          shift: false,
          meta: process.platform === 'darwin',
          control: process.platform !== 'darwin',
          ...input
        } as Electron.Input
      )
    }
    return preventDefault
  }
  return { guest, webContents, press }
}

describe('withAgentInputInjection', () => {
  it('marks nested injection and ignores menu shortcuts only while it lasts', async () => {
    const { guest, webContents } = fakeGuest()

    await withAgentInputInjection(webContents, async () => {
      await withAgentInputInjection(webContents, async () => {
        expect(isAgentInjectingInput(webContents)).toBe(true)
      })
      expect(isAgentInjectingInput(webContents)).toBe(true)
    })

    expect(isAgentInjectingInput(webContents)).toBe(false)
    expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]])
  })

  it('clears the mark when the injected input fails', async () => {
    const { webContents } = fakeGuest()

    await expect(
      withAgentInputInjection(webContents, async () => {
        throw new Error('page gone')
      })
    ).rejects.toThrow('page gone')

    expect(isAgentInjectingInput(webContents)).toBe(false)
  })

  it('keeps Orca shortcuts and grab copy from acting on injected keys', async () => {
    const { webContents, press } = fakeGuest()
    const send = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding only calls send and isDestroyed.
    const renderer = { send, isDestroyed: () => false } as unknown as Electron.WebContents
    setupGuestShortcutForwarding({
      browserTabId: 'tab-1',
      guest: webContents,
      resolveRenderer: () => renderer
    })
    setupGrabShortcutForwarding({
      browserTabId: 'tab-1',
      guest: webContents,
      resolveRenderer: () => renderer,
      hasActiveGrabOp: () => true
    })

    await withAgentInputInjection(webContents, async () => {
      expect(press({ code: 'KeyT', key: 't' })).not.toHaveBeenCalled()
      expect(press({ code: 'KeyW', key: 'w' })).not.toHaveBeenCalled()
      press({ code: 'KeyC', key: 'c', meta: false, control: false })
    })
    expect(send).not.toHaveBeenCalled()

    // Why: the same key from the user still reaches Orca.
    expect(press({ code: 'KeyT', key: 't' })).toHaveBeenCalled()
  })
})
