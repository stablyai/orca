import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetTerminalViewAttributesForTest,
  admitPairedCreateColors,
  getTerminalViewAttributes,
  getTerminalViewerColors,
  registerTerminalViewAttributesApplier,
  setPairedViewAttributes,
  setPairedViewerColors
} from './terminal-view-attribute-store'
import {
  TERMINAL_VIEW_ANSI_COLOR_COUNT,
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes,
  type TerminalViewRgb
} from '../../../../shared/terminal/protocol/queries/terminal-view-attributes'

function makeAttributes(
  foreground: TerminalViewRgb,
  background: TerminalViewRgb,
  colorSchemeMode: 'dark' | 'light'
): TerminalViewAttributes {
  const ansi: TerminalViewRgb[] = Array.from({ length: TERMINAL_VIEW_ANSI_COLOR_COUNT }, (_, i) => [
    i,
    i,
    i
  ])
  return {
    foreground,
    background,
    cursor: foreground,
    ansi,
    colorSchemeMode,
    cursorStyle: 'block',
    cursorBlink: false
  }
}

describe('admitPairedCreateColors', () => {
  beforeEach(() => {
    _resetTerminalViewAttributesForTest()
  })

  it('never reapplies host-wide appearance to existing emulators on alternating headless launches and pins differing themes', () => {
    const dark = makeAttributes([230, 230, 230], [20, 20, 20], 'dark')
    const light = makeAttributes([20, 20, 20], [245, 245, 245], 'light')
    const darkColors = terminalViewColorQueryReplyColors(dark)
    const lightColors = terminalViewColorQueryReplyColors(light)

    // Initial host-wide push from client A via terminal.setViewerColors.
    setPairedViewerColors(darkColors)
    setPairedViewAttributes(dark)

    let globalApplyCount = 0
    registerTerminalViewAttributesApplier(() => {
      globalApplyCount += 1
    })

    // Alternating launches between client B (light) and client A (dark).
    for (let i = 0; i < 10; i++) {
      const lightSpawn = admitPairedCreateColors(lightColors, light)
      expect(lightSpawn).toEqual({
        launcherColorQueryReplies: lightColors,
        launcherViewAttributes: light
      })

      const darkSpawn = admitPairedCreateColors(darkColors, dark)
      expect(darkSpawn).toEqual({})
    }

    expect(globalApplyCount).toBe(0)
    expect(getTerminalViewerColors()).toEqual(darkColors)
    expect(getTerminalViewAttributes()).toEqual(dark)
  })
})
