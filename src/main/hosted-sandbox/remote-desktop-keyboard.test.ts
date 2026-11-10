import { describe, expect, it } from 'vitest'
import {
  createReleaseChordTracker,
  remoteDesktopPasteChord,
  type RemoteDesktopKeyInput
} from './remote-desktop-keyboard'

function key(
  type: 'keyDown' | 'keyUp',
  keyName: string,
  mods: Partial<Pick<RemoteDesktopKeyInput, 'control' | 'alt' | 'meta' | 'shift'>> = {}
): RemoteDesktopKeyInput {
  return {
    type,
    key: keyName,
    code: keyName === 'v' || keyName === 'V' ? 'KeyV' : keyName,
    control: false,
    alt: false,
    meta: false,
    shift: false,
    isAutoRepeat: false,
    ...mods
  }
}

describe('remote desktop release chord', () => {
  it('releases on macOS when Control+Command are pressed and let go with nothing else', () => {
    const track = createReleaseChordTracker('darwin')
    expect(track(key('keyDown', 'Control', { control: true }))).toBe(false)
    expect(track(key('keyDown', 'Meta', { control: true, meta: true }))).toBe(false)
    expect(track(key('keyUp', 'Meta', { control: true }))).toBe(true)
    // Its other key going up does not release twice.
    expect(track(key('keyUp', 'Control'))).toBe(false)
  })

  it('keeps Ctrl+Alt+T and other chords for the desktop', () => {
    const track = createReleaseChordTracker('linux')
    track(key('keyDown', 'Control', { control: true }))
    track(key('keyDown', 'Alt', { control: true, alt: true }))
    expect(track(key('keyDown', 't', { control: true, alt: true }))).toBe(false)
    expect(track(key('keyUp', 'Alt', { control: true }))).toBe(false)
    // Shift joining the chord is something else too.
    track(key('keyDown', 'Control', { control: true }))
    track(key('keyDown', 'Alt', { control: true, alt: true }))
    track(key('keyDown', 'Shift', { control: true, alt: true, shift: true }))
    expect(track(key('keyUp', 'Alt', { control: true, shift: true }))).toBe(false)
  })

  it('uses Ctrl+Alt off macOS and ignores Control+Command there', () => {
    const win = createReleaseChordTracker('win32')
    win(key('keyDown', 'Control', { control: true }))
    win(key('keyDown', 'Meta', { control: true, meta: true }))
    expect(win(key('keyUp', 'Meta', { control: true }))).toBe(false)
    win(key('keyDown', 'Alt', { control: true, alt: true }))
    expect(win(key('keyUp', 'Control', { alt: true }))).toBe(true)
  })

  it('ignores AltGr (reported as Ctrl+Alt) on Windows', () => {
    const win = createReleaseChordTracker('win32')
    win({ ...key('keyDown', 'Control', { control: true }), code: 'ControlLeft' })
    win({ ...key('keyDown', 'Alt', { control: true, alt: true }), code: 'AltRight' })
    expect(win({ ...key('keyUp', 'Alt', { control: true }), code: 'AltRight' })).toBe(false)
  })

  it('never releases on plain typing or a lone modifier', () => {
    const track = createReleaseChordTracker('darwin')
    for (const input of [
      key('keyDown', 'Meta', { meta: true }),
      key('keyDown', 'c', { meta: true }),
      key('keyUp', 'c', { meta: true }),
      key('keyUp', 'Meta'),
      key('keyDown', 'Control', { control: true }),
      key('keyUp', 'Control')
    ]) {
      expect(track(input)).toBe(false)
    }
  })
})

describe('remote desktop paste keys', () => {
  it('turns Cmd+V on macOS into a sandbox paste', () => {
    expect(remoteDesktopPasteChord(key('keyDown', 'v', { meta: true }), 'darwin')).toEqual({
      kind: 'mac'
    })
    expect(remoteDesktopPasteChord(key('keyDown', 'v', { meta: true }), 'linux')).toBeNull()
  })

  it('replays the Linux paste keys after setting the clipboard', () => {
    expect(remoteDesktopPasteChord(key('keyDown', 'v', { control: true }), 'linux')).toEqual({
      kind: 'replay',
      key: 'v'
    })
    expect(
      remoteDesktopPasteChord(key('keyDown', 'V', { control: true, shift: true }), 'darwin')
    ).toEqual({ kind: 'replay', key: 'V' })
    expect(remoteDesktopPasteChord(key('keyDown', 'Insert', { shift: true }), 'win32')).toEqual({
      kind: 'replay',
      key: 'Insert'
    })
  })

  it('follows the keyboard layout, not the physical key', () => {
    // Dvorak: Ctrl+K is typed on the physical V key and must reach the sandbox untouched.
    expect(
      remoteDesktopPasteChord({ ...key('keyDown', 'k', { control: true }), code: 'KeyV' }, 'linux')
    ).toBeNull()
    // Cyrillic: the V key types 'м'; Ctrl+V there is still paste.
    expect(
      remoteDesktopPasteChord({ ...key('keyDown', 'м', { control: true }), code: 'KeyV' }, 'linux')
    ).toEqual({ kind: 'replay', key: 'v' })
  })

  it('leaves other keys and key-ups alone', () => {
    expect(remoteDesktopPasteChord(key('keyUp', 'v', { control: true }), 'linux')).toBeNull()
    expect(remoteDesktopPasteChord(key('keyDown', 'c', { control: true }), 'linux')).toBeNull()
    expect(remoteDesktopPasteChord(key('keyDown', 'v'), 'linux')).toBeNull()
    expect(
      remoteDesktopPasteChord(key('keyDown', 'v', { control: true, alt: true }), 'linux')
    ).toBeNull()
  })
})
