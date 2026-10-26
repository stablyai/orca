// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { createTerminalDocument } from './create-terminal-document'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html'

function plantHost(id: string) {
  const host = document.createElement('div')
  host.id = id
  host.innerHTML = TERMINAL_DOCUMENT_MARKUP
  document.body.appendChild(host)
  return host
}

function startDocumentIn(host: HTMLElement) {
  const engine = terminalDocumentDouble()
  const posted: Array<Record<string, unknown>> = []
  const started = createTerminalDocument({
    root: host,
    postToHost: (message) => {
      posted.push(message)
    },
    hasEngine: () => true,
    installHostTransport: () => () => {},
    installErrorReporter: () => () => {},
    paintDocumentBackground: () => {},
    createTerminal: () => engine.terminal,
    createUnicode11Addon: () => null,
    createWebglAddon: () => null
  })
  started.send({ type: 'init', cols: 80, rows: 24, initialData: '', preserveScroll: false })
  return { started, openedOn: engine.openedOn, posted }
}

type PlantedFinger = { surface: HTMLElement; identifier: number; x?: number; y?: number }

// Dispatch on document with page-wide touches so both terminal scopes receive the event and must filter ownership.
function fireTouch(type: string, fingers: PlantedFinger[], target: HTMLElement) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: fingers.map((finger) => ({
      identifier: finger.identifier,
      clientX: finger.x ?? 10,
      clientY: finger.y ?? 10,
      target: finger.surface
    }))
  })
  Object.defineProperty(event, 'target', { value: target })
  document.dispatchEvent(event)
}

function fireTwoFingerTouchStart(surface: HTMLElement) {
  fireTouch(
    'touchstart',
    [
      { surface, identifier: 0, x: 10 },
      { surface, identifier: 1, x: 30 }
    ],
    surface
  )
}

function elementOf(host: HTMLElement, id: string) {
  const element = host.querySelector<HTMLElement>(`#${id}`)
  if (element === null) {
    throw new Error(`${host.id} carries no #${id}`)
  }
  return element
}

const surfaceOf = (host: HTMLElement) => elementOf(host, 'terminal-surface')

function selectAllInBoth(...documents: Array<ReturnType<typeof startDocumentIn>>) {
  for (const started of documents) {
    started.started.send({ type: 'do-select-all' })
    expect(started.posted.map((message) => message.type)).toContain('set-select-mode')
    started.posted.length = 0
  }
}

const pinchCancels = (posted: Array<Record<string, unknown>>) =>
  posted.filter((message) => message.type === 'mobile-clip-cancel-by-pinch')

// Stack transitions overlap terminal mounts with duplicate markup ids; assert each engine opens its own host surface.
describe('two terminal documents on one page', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('opens each engine on the surface inside its own host', () => {
    const first = plantHost('first-host')
    const second = plantHost('second-host')

    expect(first.querySelector('#terminal-surface')).not.toBe(null)
    expect(second.querySelector('#terminal-surface')).not.toBe(null)

    const one = startDocumentIn(first)
    const two = startDocumentIn(second)

    expect(first.contains(one.openedOn() ?? null)).toBe(true)
    expect(second.contains(two.openedOn() ?? null)).toBe(true)

    one.started.stop()
    two.started.stop()
  })

  // A pinch in another host must not clear this terminal’s selection before target filtering.
  it('leaves the other document alone when two fingers land in that other host', () => {
    const first = plantHost('first-host')
    const second = plantHost('second-host')
    const one = startDocumentIn(first)
    const two = startDocumentIn(second)
    selectAllInBoth(one, two)

    fireTwoFingerTouchStart(surfaceOf(second))

    expect(pinchCancels(one.posted)).toHaveLength(0)
    expect(one.posted).toEqual([])
    expect(pinchCancels(two.posted)).toHaveLength(1)

    one.started.stop()
    two.started.stop()
  })

  // The same event inside this host must still reach it, ruling out an inert dispatcher.
  it('cancels its own selection when the two fingers land in its own host', () => {
    const first = plantHost('first-host')
    const second = plantHost('second-host')
    const one = startDocumentIn(first)
    const two = startDocumentIn(second)
    selectAllInBoth(one, two)

    fireTwoFingerTouchStart(surfaceOf(first))

    expect(pinchCancels(one.posted)).toHaveLength(1)
    expect(pinchCancels(two.posted)).toHaveLength(0)

    one.started.stop()
    two.started.stop()
  })

  // Event ownership is not enough: page-wide touches must also exclude fingers in the other terminal.
  it("does not read another host's finger as its own second one", () => {
    const first = plantHost('first-host')
    const second = plantHost('second-host')
    const one = startDocumentIn(first)
    const two = startDocumentIn(second)
    selectAllInBoth(two)
    const held = { surface: surfaceOf(first), identifier: 0 }
    // Use B’s menu pill so a local tap preserves selection; surface taps dismiss it by design.
    const pill = elementOf(second, 'selection-overlay')

    fireTouch('touchstart', [held], held.surface)
    one.posted.length = 0
    two.posted.length = 0
    fireTouch('touchstart', [held, { surface: pill, identifier: 1 }], pill)

    expect(pinchCancels(two.posted)).toHaveLength(0)
    expect(two.posted).toEqual([])

    one.started.stop()
    two.started.stop()
  })

  // A finger in A must not prevent B’s last-finger touchend from firing its tap.
  it('fires its own surface tap while the other host still has a finger down', () => {
    const first = plantHost('first-host')
    const second = plantHost('second-host')
    const one = startDocumentIn(first)
    const two = startDocumentIn(second)
    const held = { surface: surfaceOf(first), identifier: 0 }
    const tapping = { surface: surfaceOf(second), identifier: 1, x: 20, y: 5 }

    fireTouch('touchstart', [held], held.surface)
    fireTouch('touchstart', [held, tapping], tapping.surface)
    two.posted.length = 0
    fireTouch('touchend', [held], tapping.surface)

    expect(two.posted.map((message) => message.type)).toContain('terminal-tap')

    one.started.stop()
    two.started.stop()
  })
})

function startMeasuredDocument() {
  document.body.innerHTML = ''
  const host = plantHost('pinch-host')
  const engine = terminalDocumentDouble()
  const parsedWrites: Array<() => void> = []
  const grid = Object.assign(engine.terminal, {
    cols: 80,
    rows: 24,
    _core: {
      _renderService: {
        get dimensions() {
          const k = grid.options.fontSize / 13
          return { css: { cell: { width: 7.5 * k, height: 15 * k } } }
        }
      }
    }
  })
  grid.resize = (cols: number, rows: number) => {
    grid.cols = cols
    grid.rows = rows
  }
  grid.onWriteParsed = (listener: () => void) => {
    parsedWrites.push(listener)
    return { dispose() {} }
  }
  const posted: Array<Record<string, unknown>> = []
  const started = createTerminalDocument({
    root: host,
    postToHost: (message) => {
      posted.push(message)
    },
    hasEngine: () => true,
    installHostTransport: () => () => {},
    installErrorReporter: () => () => {},
    paintDocumentBackground: () => {},
    viewportRect: () => ({ left: 0, top: 0, width: 412, height: 600 }),
    createTerminal: () => grid,
    createUnicode11Addon: () => null,
    createWebglAddon: () => null
  })
  started.send({
    type: 'init',
    cols: 80,
    rows: 24,
    initialData: '',
    preserveScroll: false,
    frame: { width: 412, height: 600 }
  })
  const write = () => parsedWrites.forEach((listener) => listener())
  return { started, posted, surface: surfaceOf(host), write }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() {
  for (let frame = 0; frame < 10; frame++) {
    await nextFrame()
  }
}

const metricsOf = (posted: Array<Record<string, unknown>>) =>
  posted.filter((message) => message.type === 'keyboard-avoidance-metrics')

function fireSurfaceTouch(type: string, surface: HTMLElement, xs: number[]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: xs.map((x, identifier) => ({ identifier, clientX: x, clientY: 10, target: surface }))
  })
  surface.dispatchEvent(event)
}

function pinchTo(doc: ReturnType<typeof startMeasuredDocument>, spread: number, write = true) {
  fireSurfaceTouch('touchstart', doc.surface, [10, 30])
  fireSurfaceTouch('touchmove', doc.surface, [10, 10 + spread])
  if (write) {
    doc.write()
  }
  fireSurfaceTouch('touchend', doc.surface, [])
}

// Pinch changes row pitch without a fit; release must replace metrics emitted during a mid-gesture write.
describe('keyboard-avoidance metrics across a pinch', () => {
  it('reports the at-rest pitch after a pinch that releases onto the same preset', async () => {
    const doc = startMeasuredDocument()
    await settle()
    const atRest = metricsOf(doc.posted).at(-1)?.rowPitch
    expect(atRest).toBeGreaterThan(0)

    pinchTo(doc, 21)
    await settle()

    const metrics = metricsOf(doc.posted)
    expect(metrics.at(-1)?.rowPitch).toBe(atRest)
    doc.started.stop()
  })

  it('reports a release that changes the preset once, through the refit', async () => {
    const doc = startMeasuredDocument()
    await settle()
    const before = metricsOf(doc.posted).length

    pinchTo(doc, 30)
    const afterWrite = metricsOf(doc.posted).length
    await settle()

    expect(afterWrite).toBe(before + 1)
    expect(metricsOf(doc.posted).length).toBe(afterWrite + 1)
    doc.started.stop()
  })

  it('never reports the pre-refit pitch when a release lands while a refit is pending', async () => {
    const doc = startMeasuredDocument()
    await settle()
    const before = metricsOf(doc.posted).length

    // Change settings before deferred refit, then release the pinch onto that same preset.
    doc.started.send({ type: 'set-font-scale', fontScale: 1.5 })
    pinchTo(doc, 20, false)
    await settle()

    const reported = metricsOf(doc.posted).slice(before)
    expect(reported.map((message) => message.rowPitch)).toEqual([reported.at(-1)?.rowPitch])
    expect(reported.at(-1)?.rowPitch).toBeGreaterThan(20)
    doc.started.stop()
  })
})
