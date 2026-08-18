// @vitest-environment happy-dom
import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html'

type CursorCoreService = {
  isCursorHidden: boolean
  isCursorInitialized: boolean
}

type ListenerOwner = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

function cursorCoreService(terminal: Terminal): CursorCoreService {
  const core = (terminal as unknown as { _core?: { coreService?: CursorCoreService } })._core
  expect(core, 'xterm private _core compatibility').toBeDefined()
  expect(core?.coreService, 'xterm private coreService compatibility').toBeDefined()
  expect(typeof core?.coreService?.isCursorHidden).toBe('boolean')
  expect(typeof core?.coreService?.isCursorInitialized).toBe('boolean')
  return core!.coreService!
}

function listenerOwner(target: EventTarget): ListenerOwner {
  let owner = target as ListenerOwner | null
  while (owner) {
    if (Object.hasOwn(owner, 'addEventListener') && Object.hasOwn(owner, 'removeEventListener')) {
      return owner
    }
    owner = Object.getPrototypeOf(owner) as ListenerOwner | null
  }
  throw new Error(`No event-listener owner for ${target.constructor.name}`)
}

function eventListenerOwners(): ListenerOwner[] {
  const targets: EventTarget[] = [
    document,
    document.defaultView!,
    document.documentElement,
    document.body,
    document.createElement('div'),
    document.createElement('textarea'),
    document.createElement('canvas')
  ]
  return [...new Set(targets.map(listenerOwner))]
}

function trackEventListenerCleanup(): () => {
  added: number
  removed: number
  unreleased: string[]
} {
  const registrations: Array<{
    capture: boolean
    listener: EventListenerOrEventListenerObject
    removed: boolean
    target: EventTarget
    type: string
  }> = []
  const capture = (options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean =>
    typeof options === 'boolean' ? options : (options?.capture ?? false)
  const activeRegistration = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions | EventListenerOptions
  ) =>
    registrations.find(
      (entry) =>
        !entry.removed &&
        entry.target === target &&
        entry.type === type &&
        entry.listener === listener &&
        entry.capture === capture(options)
    )

  for (const owner of eventListenerOwners()) {
    const addEventListener = owner.addEventListener
    const removeEventListener = owner.removeEventListener
    vi.spyOn(owner, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) {
      addEventListener.call(this, type, listener, options)
      if (!activeRegistration(this, type, listener, options)) {
        registrations.push({
          capture: capture(options),
          listener,
          removed: false,
          target: this,
          type
        })
      }
    })
    vi.spyOn(owner, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) {
      removeEventListener.call(this, type, listener, options)
      const registration = activeRegistration(this, type, listener, options)
      if (registration) {
        registration.removed = true
      }
    })
  }

  return () => ({
    added: registrations.length,
    removed: registrations.filter((registration) => registration.removed).length,
    unreleased: registrations
      .filter((registration) => !registration.removed)
      .map((registration) => registration.type)
  })
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
    const listenerCleanup = trackEventListenerCleanup()
    const options: ITerminalOptions & ITerminalInitOnlyOptions = MOBILE_TERMINAL_CARET_OPTIONS
    const terminal = new Terminal(options)
    const container = document.createElement('div')
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
      // Why: teardown only — an assertion here would mask the body failure and strand the container.
      terminal.dispose()
      container.remove()
    }

    expect(container.querySelector('.xterm')).toBeNull()
    const cleanup = listenerCleanup()
    expect(cleanup.added).toBeGreaterThan(0)
    expect(cleanup.removed).toBe(cleanup.added)
    expect(cleanup.unreleased).toEqual([])
  })

  it('releases listeners across 25 terminal lifecycles', () => {
    const listenerCleanup = trackEventListenerCleanup()
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const terminal = new Terminal(MOBILE_TERMINAL_CARET_OPTIONS)
      const container = document.createElement('div')
      document.body.append(container)
      terminal.open(container)
      terminal.dispose()
      expect(container.querySelector('.xterm')).toBeNull()
      container.remove()
    }

    const cleanup = listenerCleanup()
    expect(cleanup.added).toBeGreaterThan(0)
    expect(cleanup.removed).toBe(cleanup.added)
    expect(cleanup.unreleased).toEqual([])
  })
})
