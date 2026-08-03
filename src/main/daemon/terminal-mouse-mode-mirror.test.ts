import { describe, expect, it } from 'vitest'
import { TerminalMouseModeMirror } from './terminal-mouse-mode-mirror'

describe('TerminalMouseModeMirror', () => {
  it('mirrors DECSET mouse tracking and SGR encoding modes', () => {
    const mirror = new TerminalMouseModeMirror()
    expect(mirror.mouseTrackingMode).toBe('none')

    mirror.scan('\x1b[?1002h\x1b[?1006h')
    expect(mirror.mouseTrackingMode).toBe('drag')
    expect(mirror.sgrMouseMode).toBe(true)

    mirror.scan('\x1b[?1002l')
    expect(mirror.mouseTrackingMode).toBe('none')
  })

  it('assembles a DECSET split across chunks', () => {
    const mirror = new TerminalMouseModeMirror()
    mirror.scan('output\x1b[?100')
    expect(mirror.mouseTrackingMode).toBe('none')

    mirror.scan('3h')
    expect(mirror.mouseTrackingMode).toBe('any')
  })

  it('clears mirrored modes on RIS', () => {
    const mirror = new TerminalMouseModeMirror()
    mirror.scan('\x1b[?1003h\x1b[?1016h')
    expect(mirror.sgrMousePixelsMode).toBe(true)

    mirror.scan('\x1bc')
    expect(mirror.mouseTrackingMode).toBe('none')
    expect(mirror.sgrMousePixelsMode).toBe(false)
  })
})
