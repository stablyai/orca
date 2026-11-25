import { afterEach, describe, expect, it } from 'vitest'
import {
  forwardGuestShortcutInput,
  type GuestShortcutForwardContext
} from './browser-guest-shortcut-dispatch'

const originalPlatform = process.platform

function forward(
  platform: NodeJS.Platform,
  input: Parameters<typeof forwardGuestShortcutInput>[2]
) {
  Object.defineProperty(process, 'platform', { value: platform })
  const sent: unknown[][] = []
  const renderer = { send: (...args: unknown[]) => sent.push(args) }
  const ctx: GuestShortcutForwardContext = {
    browserTabId: 'page-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only calls send()
    resolveRenderer: () => renderer as unknown as Electron.WebContents,
    getKeybindings: () => ({}),
    forwardBrowserPageZoom: () => {}
  }
  let prevented = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only calls preventDefault()
  const event = { preventDefault: () => (prevented = true) } as unknown as Electron.Event
  const handled = forwardGuestShortcutInput(ctx, event, { type: 'keyDown', ...input })
  return { handled, sent, prevented }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('focused browser page forwarding Search Tabs', () => {
  it('takes the chord from the page and opens tab search on every platform', () => {
    for (const [platform, input] of [
      ['darwin', { key: 'a', code: 'KeyA', meta: true, shift: true }],
      ['linux', { key: 'A', code: 'KeyA', control: true, shift: true }],
      ['win32', { key: 'A', code: 'KeyA', control: true, shift: true }]
    ] as const) {
      expect(forward(platform, input)).toEqual({
        handled: true,
        sent: [['ui:toggleTabSearch']],
        prevented: true
      })
    }
  })
})
