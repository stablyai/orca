import { describe, expect, it, vi } from 'vitest'
import {
  installWindowsPathRegistryChangeListener,
  WINDOWS_SETTING_CHANGE_MESSAGE
} from './windows-path-registry-change'

describe('installWindowsPathRegistryChangeListener', () => {
  it('invalidates the persisted PATH cache on a Windows settings change', () => {
    const hooks = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
    const invalidate = vi.fn()
    installWindowsPathRegistryChangeListener(
      {
        hookWindowMessage: (message, callback) => {
          hooks.set(message, callback)
        }
      },
      { invalidate, platform: 'win32' }
    )

    hooks.get(WINDOWS_SETTING_CHANGE_MESSAGE)?.(Buffer.alloc(0), Buffer.alloc(0))

    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('does not hook native messages outside Windows', () => {
    const hookWindowMessage = vi.fn()

    installWindowsPathRegistryChangeListener({ hookWindowMessage }, { platform: 'linux' })

    expect(hookWindowMessage).not.toHaveBeenCalled()
  })
})
