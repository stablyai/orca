// @vitest-environment happy-dom
import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html'

type CursorCoreService = {
  isCursorHidden: boolean
  isCursorInitialized: boolean
}

function cursorCoreService(terminal: Terminal): CursorCoreService {
  const core = (terminal as unknown as { _core?: { coreService?: CursorCoreService } })._core
  expect(core, 'xterm private _core compatibility').toBeDefined()
  expect(core?.coreService, 'xterm private coreService compatibility').toBeDefined()
  expect(typeof core?.coreService?.isCursorHidden).toBe('boolean')
  expect(typeof core?.coreService?.isCursorInitialized).toBe('boolean')
  return core!.coreService!
}

function trackEventListenerCleanup(): () => string[] {
  const registrations: Array<{
    capture: boolean
    listener: EventListenerOrEventListenerObject
    removed: boolean
    target: EventTarget
    type: string
  }> = []
  const prototype = window.EventTarget.prototype
  const addEventListener = prototype.addEventListener
  const removeEventListener = prototype.removeEventListener
  const capture = (options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean =>
    typeof options === 'boolean' ? options : (options?.capture ?? false)

  vi.spyOn(prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    registrations.push({ capture: capture(options), listener, removed: false, target: this, type })
    addEventListener.call(this, type, listener, options)
  })
  vi.spyOn(prototype, 'removeEventListener').mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) {
    const registration = registrations.find(
      (entry) =>
        !entry.removed &&
        entry.target === this &&
        entry.type === type &&
        entry.listener === listener &&
        entry.capture === capture(options)
    )
    if (registration) {
      registration.removed = true
    }
    removeEventListener.call(this, type, listener, options)
  })

  return () =>
    registrations
      .filter((registration) => !registration.removed)
      .map((registration) => registration.type)
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('xterm caret rendering oracle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): Pick<CanvasRenderingContext2D, 'font' | 'measureText'> {
          return { font: '', measureText: () => ({ width: 8 }) as TextMetrics }
        }
      }
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders and hides an unfocused main-buffer caret', async () => {
    const options: ITerminalOptions & ITerminalInitOnlyOptions = MOBILE_TERMINAL_CARET_OPTIONS
    const terminal = new Terminal(options)
    const container = document.createElement('div')
    const unreleasedListeners = trackEventListenerCleanup()
    document.body.append(container)

    try {
      terminal.open(container)
      await write(terminal, '\x1b[?25h\x1b[2K\x1b[1G> hello\x1b[?2004h\x1b[1;3H')
      terminal.refresh(0, terminal.rows - 1)
      await vi.waitFor(() => expect(container.textContent).toContain('hello'))
      const coreService = cursorCoreService(terminal)
      expect({
        initialized: coreService.isCursorInitialized,
        rendered: container.querySelector('.xterm-cursor') !== null
      }).toEqual({ initialized: true, rendered: true })

      await write(terminal, '\x1b[?25l')
      terminal.refresh(0, terminal.rows - 1)
      await vi.waitFor(() => expect(container.querySelector('.xterm-cursor')).toBeNull())
      expect({
        hidden: coreService.isCursorHidden,
        rendered: container.querySelector('.xterm-cursor') !== null
      }).toEqual({ hidden: true, rendered: false })
    } finally {
      terminal.dispose()
      expect(container.querySelector('.xterm')).toBeNull()
      expect(unreleasedListeners()).toEqual([])
      container.remove()
    }
  })
})
