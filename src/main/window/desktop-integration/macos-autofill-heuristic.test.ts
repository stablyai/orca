import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ systemPreferences: { registerDefaults: vi.fn() } }))

import {
  disableMacAutoFillHeuristic,
  MAC_AUTOFILL_HEURISTIC_DEFAULTS
} from './macos-autofill-heuristic'

describe('disableMacAutoFillHeuristic', () => {
  it('registers both AutoFill keys as false on macOS', () => {
    const registerDefaults = vi.fn()
    expect(disableMacAutoFillHeuristic({ platform: 'darwin', registerDefaults })).toBe(true)
    expect(registerDefaults).toHaveBeenCalledWith({
      NSAutoFillHeuristicControllerEnabled: false,
      NSAutoFillHeuristicsEnabled: false
    })
    expect(registerDefaults.mock.calls[0][0]).toEqual(MAC_AUTOFILL_HEURISTIC_DEFAULTS)
  })

  it('does nothing on other platforms', () => {
    const registerDefaults = vi.fn()
    expect(disableMacAutoFillHeuristic({ platform: 'linux', registerDefaults })).toBe(false)
    expect(disableMacAutoFillHeuristic({ platform: 'win32', registerDefaults })).toBe(false)
    expect(registerDefaults).not.toHaveBeenCalled()
  })

  it('keeps startup going when AppKit rejects the defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registerDefaults = vi.fn(() => {
      throw new Error('boom')
    })
    expect(disableMacAutoFillHeuristic({ platform: 'darwin', registerDefaults })).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
