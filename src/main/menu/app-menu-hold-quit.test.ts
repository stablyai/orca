import { afterEach, expect, it, vi } from 'vitest'
import { createAppMenuQuitItem } from './app-menu-quit-item'

vi.mock('../window/desktop-hold-quit-surface', () => ({
  hasFocusedDesktopHoldQuitSurface: () => true
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

it('removes both native quit role and accelerator only for the enabled macOS keyboard guard', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const quit = vi.fn()
  const enabled = createAppMenuQuitItem(undefined, 'Orca', { isEnabled: () => true, quit })
  expect(enabled.role).toBeUndefined()
  expect(enabled.accelerator).toBeUndefined()
  expect(enabled.label).toContain('⌘Q')
  if (enabled.click) {
    enabled.click()
  }
  expect(quit).toHaveBeenCalledOnce()
  expect(createAppMenuQuitItem(undefined, 'Orca', { isEnabled: () => false, quit }).role).toBe(
    'quit'
  )
})

it.each(['linux', 'win32'])('preserves %s native quit and serve callback policies', (value) => {
  Object.defineProperty(process, 'platform', { value })
  const quit = vi.fn()
  expect(createAppMenuQuitItem(undefined, 'Orca', { isEnabled: () => true, quit }).role).toBe(
    'quit'
  )
  const serve = createAppMenuQuitItem(quit)
  expect(serve.accelerator).toBe(value === 'win32' ? undefined : 'CmdOrCtrl+Q')
})
