import { systemPreferences } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATIC_PERIOD_SUBSTITUTION_KEY,
  disableMacAutomaticPeriodSubstitution
} from './macos-automatic-period-substitution'

vi.mock('electron', () => ({ systemPreferences: { setUserDefault: vi.fn() } }))

// #11504: on m4air (macOS 26.5.2, packaged build, global preference on) typing `a b <space>
// <space>` in a terminal put `["a","b"," ",". "]` on the PTY. With this override written to
// Orca's own defaults domain the same keystrokes put `["a","b"," "," "]` there — no period.
// Sealed at .tmp/ime-handoff/swarm-scratch/wave27-11504fix/.
describe('disableMacAutomaticPeriodSubstitution', () => {
  beforeEach(() => {
    vi.mocked(systemPreferences.setUserDefault).mockReset()
  })

  it('writes the app-domain override on macOS', () => {
    const setUserDefault = vi.fn()

    expect(disableMacAutomaticPeriodSubstitution({ platform: 'darwin', setUserDefault })).toBe(true)
    expect(setUserDefault).toHaveBeenCalledWith(AUTOMATIC_PERIOD_SUBSTITUTION_KEY, 'boolean', false)
  })

  // Why: startup calls this with no options, so Electron delegation is the path that actually ships.
  it('writes through systemPreferences when no writer is injected', () => {
    expect(disableMacAutomaticPeriodSubstitution({ platform: 'darwin' })).toBe(true)
    expect(systemPreferences.setUserDefault).toHaveBeenCalledWith(
      AUTOMATIC_PERIOD_SUBSTITUTION_KEY,
      'boolean',
      false
    )
  })

  // The other direction of #11504: suppress the substitution the OS invents, and nothing else.
  // Quote and dash substitution stay as the user set them, and a period the user types is never
  // routed through here at all — it reaches the PTY as an ordinary keystroke
  // (terminal-stock-composition.issue-11504-macos-period-substitution.test.ts pins that arm).
  it('disables period substitution only', () => {
    const setUserDefault = vi.fn()

    disableMacAutomaticPeriodSubstitution({ platform: 'darwin', setUserDefault })

    expect(setUserDefault.mock.calls).toEqual([
      [AUTOMATIC_PERIOD_SUBSTITUTION_KEY, 'boolean', false]
    ])
  })

  it.each(['win32', 'linux'] as const)('does not touch defaults on %s', (platform) => {
    const setUserDefault = vi.fn()

    expect(disableMacAutomaticPeriodSubstitution({ platform, setUserDefault })).toBe(false)
    expect(setUserDefault).not.toHaveBeenCalled()
  })

  it('survives a failing preferences write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const setUserDefault = vi.fn(() => {
      throw new Error('defaults unavailable')
    })

    expect(disableMacAutomaticPeriodSubstitution({ platform: 'darwin', setUserDefault })).toBe(
      false
    )
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
