import { afterEach, describe, expect, it } from 'vitest'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import {
  _resetColorQueryReplyColorsForTest,
  getLocalPtyProvider,
  publishColorQueryReplyColors,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
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
    unregisterSshPtyProvider('ssh-colors')
    setLocalPtyProvider(originalLocal)
  })

  it('pushes every change to each owner, and the latest to owners that register later', () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    const early = new RecordingProvider()
    registerSshPtyProvider('ssh-colors', early)
    // Why nothing yet: pushing "unknown" would wipe the theme a surviving daemon still holds.
    expect([...local.pushes, ...early.pushes]).toEqual([])

    publishColorQueryReplyColors(DARK)
    publishColorQueryReplyColors(LIGHT)
    const late = new RecordingProvider()
    registerSshPtyProvider('ssh-colors', late)

    expect(local.pushes).toEqual([DARK, LIGHT])
    expect(early.pushes).toEqual([DARK, LIGHT])
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
