import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import {
  _resetTerminalViewAttributesForTest,
  getTerminalViewAttributes,
  getTerminalViewerColors,
  setPairedViewerColors,
  setTerminalViewAttributes,
  setTerminalViewerColorsListener
} from '../../../runtime/terminal-view-attribute-store'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import {
  _resetColorQueryReplyColorsForTest,
  getLocalPtyProvider,
  setLocalPtyProvider
} from '../provider/registry'
import { installTerminalViewAttributesIpc } from './terminal-view-attributes-ipc'

class RecordingProvider extends LocalPtyProvider {
  readonly pushes: TerminalOscColorQueryReplyColors[] = []

  override setColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
    this.pushes.push(colors)
  }
}

const DESKTOP_ATTRIBUTES: TerminalViewAttributes = {
  foreground: [0, 0, 0],
  background: [0x12, 0x34, 0x56],
  cursor: [0, 0, 0],
  ansi: Array.from({ length: 256 }, (): [number, number, number] => [0, 0, 0]),
  colorSchemeMode: 'light',
  cursorStyle: 'block',
  cursorBlink: false
}
const DESKTOP = { foreground: '#000000', background: '#123456' }
const CLIENT = { foreground: '#2e3434', background: '#ffffff' }

describe('seeding PTY owner colours from saved settings', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  it('seeds a light-appearance host with its light theme before any renderer push', () => {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({
      getSettings: () => ({ ...settings, theme: 'system' }),
      options: { systemPrefersDark: () => false }
    })

    expect(owner.pushes).toEqual([{ foreground: '#2e3434', background: '#ffffff' }])
  })

  it('seeds a host with no display from its saved dark theme', () => {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }) })

    expect(owner.pushes).toEqual([{ foreground: '#ffffff', background: '#282c34' }])
  })

  it('publishes colours a renderer already pushed instead of the saved theme', () => {
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => settings })

    expect(owner.pushes).toEqual([DESKTOP])
  })
})

describe('one viewer colour value for every PTY owner', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')
  const SEED = { foreground: '#ffffff', background: '#282c34' }

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  function install(): RecordingProvider {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)
    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }) })
    return owner
  }

  it("keeps this host's own window theme when a paired client pushes", () => {
    const owner = install()
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)

    setPairedViewerColors(CLIENT)

    expect(getTerminalViewerColors()).toEqual(DESKTOP)
    expect(owner.pushes).toEqual([SEED, DESKTOP])
    expect(getTerminalViewAttributes()).toBe(DESKTOP_ATTRIBUTES)
  })

  it("answers with a paired client's theme on a host with no window of its own", () => {
    const owner = install()

    setPairedViewerColors(CLIENT)

    expect(getTerminalViewerColors()).toEqual(CLIENT)
    expect(owner.pushes).toEqual([SEED, CLIENT])
  })

  it("switches to this host's window theme once its renderer pushes", () => {
    const owner = install()
    setPairedViewerColors(CLIENT)

    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    setPairedViewerColors({ foreground: '#111111', background: '#eeeeee' })

    expect(getTerminalViewerColors()).toEqual(DESKTOP)
    expect(owner.pushes).toEqual([SEED, CLIENT, DESKTOP])
  })

  it('falls back to the saved theme until any viewer reports', () => {
    const owner = install()

    expect(getTerminalViewerColors()).toEqual(SEED)
    expect(owner.pushes).toEqual([SEED])
  })

  it('notifies once per change of the answered colours', () => {
    install()
    const published: unknown[] = []
    setTerminalViewerColorsListener((colors) => published.push(colors))

    setPairedViewerColors(CLIENT)
    setPairedViewerColors({ ...CLIENT })
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    setTerminalViewAttributes({ ...DESKTOP_ATTRIBUTES, cursorBlink: true })
    setPairedViewerColors({ foreground: '#111111', background: '#eeeeee' })

    expect(published).toEqual([CLIENT, DESKTOP])
  })
})
