import { describe, expect, it } from 'vitest'
import { isTerminalCommandDockVisible } from './mobile-session-command-dock-visibility'

const terminalOnScreen = {
  activeMarkdownTab: null,
  activeFileTab: null,
  activeBrowserTab: null,
  showNativeChat: false,
  activeViewUndecided: false
}

describe('isTerminalCommandDockVisible', () => {
  it('shows the terminal input under a visible terminal only', () => {
    expect(isTerminalCommandDockVisible(terminalOnScreen)).toBe(true)
    expect(isTerminalCommandDockVisible({ ...terminalOnScreen, showNativeChat: true })).toBe(false)
    expect(isTerminalCommandDockVisible({ ...terminalOnScreen, activeFileTab: {} })).toBe(false)
  })

  it('hides it while the view is still settling behind the spinner (R3-F2)', () => {
    expect(isTerminalCommandDockVisible({ ...terminalOnScreen, activeViewUndecided: true })).toBe(
      false
    )
  })
})
