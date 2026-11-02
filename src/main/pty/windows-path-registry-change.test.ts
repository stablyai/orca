import { describe, expect, it, vi } from 'vitest'
import { installWindowsPathRegistryChangeListener } from './windows-path-registry-change'

describe('installWindowsPathRegistryChangeListener', () => {
  it('does not hook native messages outside Windows', () => {
    const hookWindowMessage = vi.fn()

    installWindowsPathRegistryChangeListener({ hookWindowMessage }, { platform: 'linux' })

    expect(hookWindowMessage).not.toHaveBeenCalled()
  })
})
