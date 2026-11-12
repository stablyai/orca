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
