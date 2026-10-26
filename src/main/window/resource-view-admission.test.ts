import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
const native = vi.hoisted(() => ({ visible: true, minimized: false, destroyed: false }))
vi.mock('../runtime/runtime-desktop-surface', () => ({
  getRuntimeDesktopSurface: () => ({
    isResourceViewVisible: () => !native.destroyed && native.visible && !native.minimized
  })
}))
import { assertResourceViewVisible } from './resource-view-admission'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked window resolver only requires a sender placeholder.
const event = { sender: {} } as IpcMainInvokeEvent

describe('native diagnostic dispatch veto', () => {
  it.each([
    [false, false, false],
    [true, true, false],
    [true, false, true]
  ])(
    'rejects hidden/minimized/destroyed windows before collection: %s %s %s',
    (visible, minimized, destroyed) => {
      Object.assign(native, { visible, minimized, destroyed })
      const provider = vi.fn()
      const collect = () => {
        assertResourceViewVisible(event, { resourceManagerView: true })
        provider()
      }
      expect(collect).toThrow('view_not_visible')
      expect(provider).not.toHaveBeenCalled()
      expect(() => assertResourceViewVisible(event)).not.toThrow()
    }
  )
  it('admits a visible window without requiring focus', () => {
    Object.assign(native, { visible: true, minimized: false, destroyed: false })
    expect(() => assertResourceViewVisible(event, { resourceManagerView: true })).not.toThrow()
  })
})
