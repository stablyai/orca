import { afterEach, describe, expect, it } from 'vitest'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import {
  _resetColorQueryReplyColorsForTest,
  getLocalPtyProvider,
  publishColorQueryReplyColors,
  setLocalPtyProvider
} from './registry'

class RecordingProvider extends LocalPtyProvider {
  readonly pushes: TerminalOscColorQueryReplyColors[] = []

  override setColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
    this.pushes.push(colors)
  }
}

const DARK = { foreground: '#ffffff', background: '#000000' }
const LIGHT = { foreground: '#000000', background: '#ffffff' }

describe('PTY owner colour publication', () => {
  const originalLocal = getLocalPtyProvider()

  afterEach(() => {
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  it('pushes every change to the owner, and the latest to an owner installed later', () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    // Why nothing yet: pushing "unknown" would wipe the theme a surviving daemon still holds.
    expect(local.pushes).toEqual([])

    publishColorQueryReplyColors(DARK)
    publishColorQueryReplyColors(LIGHT)
    const late = new RecordingProvider()
    setLocalPtyProvider(late)

    expect(local.pushes).toEqual([DARK, LIGHT])
    expect(late.pushes).toEqual([LIGHT])
  })

  it('does not re-push colours every owner already has', () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)

    publishColorQueryReplyColors(DARK)
    publishColorQueryReplyColors({ ...DARK })

    expect(local.pushes).toEqual([DARK])
  })
})
