// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { ESC, useTerminalMouseWebViewHarness } from './terminal-webview-mouse-test-harness'

type DocumentMessage = {
  type: string
  data?: string
  cols?: number
  rows?: number
  initialData?: string
}

function message(data: DocumentMessage) {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
}

function wheel(deltaY = 120) {
  document.getElementById('terminal-surface')!.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      clientX: 40,
      clientY: 60
    })
  )
}

function swipe() {
  const surface = document.getElementById('terminal-surface')!
  for (const [type, y] of [
    ['touchstart', 240],
    ['touchmove', 120],
    ['touchend', 120]
  ] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const touch = { identifier: 1, clientX: 40, clientY: y }
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] })
    Object.defineProperty(event, 'changedTouches', { value: [touch] })
    surface.dispatchEvent(event)
  }
}

function touchTap() {
  const surface = document.getElementById('terminal-surface')!
  for (const type of ['touchstart', 'touchend']) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const touches = type === 'touchend' ? [] : [{ identifier: 0, clientX: 40, clientY: 60 }]
    Object.defineProperty(event, 'touches', {
      value: touches.map((touch) => ({ ...touch, target: surface }))
    })
    Object.defineProperty(event, 'target', { value: surface })
    document.dispatchEvent(event)
  }
}

// What a desktop pane snapshot looks like: normal-buffer scrollback, the alternate screen, the
// tracking modes the serializer writes, then the encoding the pane appends at the very end.
const PANE_PREFIX = `scrollback\r\n${ESC}[?1049h${ESC}[H codex prompt${ESC}[?1003h`

describe('mobile mouse encoding proof', () => {
  const mouse = useTerminalMouseWebViewHarness()

  function bootAltScreen(initialData: string, mode = 'any') {
    mouse.boot(initialData)
    mouse.showAlternateBuffer()
    mouse.activeTerminal().modes.mouseTrackingMode = mode
    mouse.clearPostedMessages()
  }

  it('reports a swipe and a wheel as SGR from a pane snapshot that ends with ?1006h', () => {
    bootAltScreen(`${PANE_PREFIX}${ESC}[?1006h`)
    swipe()
    wheel(-120)
    const bytes = mouse.terminalInputBytes()
    expect(bytes).toContain(`${ESC}[<64;`)
    wheel()
    expect(mouse.terminalInputBytes()).toContain(`${ESC}[<65;`)
    expect(mouse.terminalInputBytes()).not.toContain(`${ESC}[M`)
  })

  it('loses an encoding that sits before the alternate screen the phone replays from', () => {
    bootAltScreen(`${ESC}[?1006h${PANE_PREFIX}`)
    wheel()
    expect(mouse.terminalInputBytes()).toBe('')
  })

  it('sends nothing for a wheel, a swipe or a tap while tracking has no proven encoding', () => {
    bootAltScreen(PANE_PREFIX)
    wheel()
    swipe()
    touchTap()
    expect(mouse.terminalInputBytes()).toBe('')
    expect(mouse.postedMessages().filter((posted) => posted.type === 'terminal-tap')).toHaveLength(
      1
    )
  })

  it.each([
    ['SGR', '?1006h', '[<65;'],
    ['pixel', '?1016h', '[<65;'],
    ['explicit legacy', '?1006l', '[Ma']
  ])('keeps %s encoding proven by a live write', (_name, mode, prefix) => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'
    message({ type: 'write', data: `${ESC}[${mode}${ESC}[?1003h` })
    wheel()
    expect(mouse.terminalInputBytes()).toContain(`${ESC}${prefix}`)
  })

  it('reports legacy wheel input from a pane snapshot that states the default encoding', () => {
    bootAltScreen(`${PANE_PREFIX}${ESC}[?1006l`)
    wheel()
    expect(mouse.terminalInputBytes()).toContain(`${ESC}[Ma`)
  })

  it('reports legacy wheel input for a program that enables tracking live without an encoding', () => {
    mouse.boot()
    message({ type: 'write', data: `${ESC}[?1049h${ESC}[?1000h` })
    mouse.showAlternateBuffer()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'
    wheel()
    expect(mouse.terminalInputBytes()).toContain(`${ESC}[Ma`)
  })

  it('forgets encoding proof on the next snapshot', () => {
    mouse.boot()
    message({ type: 'write', data: `${ESC}[?1006l` })
    message({ type: 'init', cols: 40, rows: 24, initialData: `${ESC}[?1003h` })
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'
    wheel()
    expect(mouse.terminalInputBytes()).toBe('')
  })

  it('keeps arrow-key scrolling for a click-only (x10) program on the alternate screen', () => {
    bootAltScreen(`${ESC}[?1049h${ESC}[?9h`, 'x10')
    wheel(-120)
    swipe()
    const bytes = mouse.terminalInputBytes()
    expect(bytes).toContain(`${ESC}[B`)
    expect(bytes).toContain(`${ESC}[A`)
    expect(bytes).not.toContain(`${ESC}[M`)
  })
})
