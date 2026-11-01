import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalViewAttributes, TerminalViewRgb } from '../../shared/terminal-view-attributes'
import {
  _resetTerminalViewAttributesForTest,
  admitPairedCreateColors,
  getTerminalViewAttributes,
  getTerminalViewerColors,
  setPairedViewAttributes,
  setTerminalViewAttributes
} from './terminal-view-attribute-store'

const LIGHT = { foreground: '#2e3434', background: '#ffffff' }

function appearance(
  foreground: TerminalViewRgb,
  background: TerminalViewRgb
): TerminalViewAttributes {
  return {
    foreground,
    background,
    cursor: foreground,
    ansi: Array.from({ length: 256 }, (): TerminalViewRgb => [0, 0, 0]),
    colorSchemeMode: background[0] > 128 ? 'light' : 'dark',
    cursorStyle: 'block',
    cursorBlink: false
  }
}

const DARK_APPEARANCE = appearance([0xff, 0xff, 0xff], [0x28, 0x2c, 0x34])
const LIGHT_APPEARANCE = appearance([0x2e, 0x34, 0x34], [0xff, 0xff, 0xff])

describe('terminal colours a paired client reports on terminal.create', () => {
  afterEach(() => _resetTerminalViewAttributesForTest())

  it('pins them to the new terminal on a windowed host, which keeps its own theme for the rest', () => {
    setTerminalViewAttributes(DARK_APPEARANCE)

    expect(admitPairedCreateColors(LIGHT)).toEqual({ launcherColorQueryReplies: LIGHT })
    expect(getTerminalViewerColors()).toEqual({ foreground: '#ffffff', background: '#282c34' })
  })

  it('pins nothing on a windowless host, whose host-wide theme becomes theirs', () => {
    expect(admitPairedCreateColors(LIGHT, LIGHT_APPEARANCE)).toEqual({})
    expect(getTerminalViewerColors()).toEqual(LIGHT)
  })

  it("drops another client's palette they contradict, and keeps one they only spell differently", () => {
    setPairedViewAttributes(DARK_APPEARANCE)
    admitPairedCreateColors({ foreground: '#FFF', background: 'rgb(40, 44, 52)' })
    expect(getTerminalViewAttributes()).toEqual(DARK_APPEARANCE)

    admitPairedCreateColors(LIGHT)
    expect(getTerminalViewAttributes()).toBeNull()
  })

  it("carries the creator's palette with its colours, but not one for another theme", () => {
    setTerminalViewAttributes(DARK_APPEARANCE)

    expect(admitPairedCreateColors(LIGHT, LIGHT_APPEARANCE)).toEqual({
      launcherColorQueryReplies: LIGHT,
      launcherViewAttributes: LIGHT_APPEARANCE
    })
    expect(admitPairedCreateColors(LIGHT, DARK_APPEARANCE)).toEqual({
      launcherColorQueryReplies: LIGHT
    })
  })
})
