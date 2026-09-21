// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { createTerminalDocument } from './create-terminal-document'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html'

/** One host element carrying the document's markup, as the page's mount plants it. */
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

/** One finger on the screen: the surface it is on, and the id it keeps for its lifetime. */
type PlantedFinger = { surface: HTMLElement; identifier: number; x?: number; y?: number }

/**
 * A touch event as the page's dispatcher sees it: every finger on the screen, not just this
 * document's.
 *
 * Dispatched on `document`, because the dispatcher's four listeners are document-level — which is
 * why a touch in one host reaches the other host's document at all. `touches` carries each finger's
 * own target, which is what says whose it is; the event's own target is the surface the gesture is
 * on.
 */
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

/** Both documents in select mode, with what they posted getting there discarded. */
function selectAllInBoth(...documents: Array<ReturnType<typeof startDocumentIn>>) {
  for (const started of documents) {
    started.started.send({ type: 'do-select-all' })
    expect(started.posted.map((message) => message.type)).toContain('set-select-mode')
    started.posted.length = 0
  }
}

const pinchCancels = (posted: Array<Record<string, unknown>>) =>
  posted.filter((message) => message.type === 'mobile-clip-cancel-by-pinch')

/**
 * Two documents on one page read their own elements.
 *
 * Ruling 22 gave each call its own scope, which left the element reads as the last thing two
 * documents shared: they were `document.getElementById`, and the ids are in the markup every host
 * plants, so the second document's start sequence found the first host's surface, overlay, handles
 * and menu. Both documents then drove one terminal, and the second host stayed empty.
 *
 * It is reachable rather than theoretical. expo-router keeps the outgoing screen mounted for the
 * length of a stack transition, so two routes that both hold a terminal have two live documents on
 * the page while the animation runs.
 *
 * The oracle is where the engine opens. `term.open(element)` is the one call that says which
 * surface a document is actually driving, and it is read off the seam rather than off the scope,
 * which no caller can reach.
 */
describe('two terminal documents on one page', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('opens each engine on the surface inside its own host', () => {
    const first = plantHost('first-host')
    const second = plantHost('second-host')

    // The precondition, read before either document starts: both hosts carry a surface under the
    // same id, which is the shape that made a page-wide read wrong. A page with one surface on it
    // would agree with the assertions below for no reason.
    expect(first.querySelector('#terminal-surface')).not.toBe(null)
    expect(second.querySelector('#terminal-surface')).not.toBe(null)

    const one = startDocumentIn(first)
    const two = startDocumentIn(second)

    expect(first.contains(one.openedOn() ?? null)).toBe(true)
    expect(second.contains(two.openedOn() ?? null)).toBe(true)

    one.started.stop()
    two.started.stop()
  })

  /**
   * The reviewer's repro (round 1, H1): the dispatcher's four listeners are on `document`, and the
   * two-finger branch acts before it looks at the target, so a pinch anywhere on the page dropped
   * the selection of every document on it.
   */
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

  // The control: the same event inside the document's own host still reaches it. Without this the
  // assertion above passes for a dispatcher that ignores every touch.
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

  /**
   * Round 2's residual, the same defect one level in: `eventTargetInRoot` settles whose event it is,
   * and then every branch counts `e.touches`, which is every finger on the screen. A finger resting
   * in the other terminal is therefore this one's second finger.
   */
  it("does not read another host's finger as its own second one", () => {
    const first = plantHost('first-host')
    const second = plantHost('second-host')
    const one = startDocumentIn(first)
    const two = startDocumentIn(second)
    selectAllInBoth(two)
    const held = { surface: surfaceOf(first), identifier: 0 }
    // B's menu pill rather than its surface: a touch there is the one place a single finger leaves
    // the selection alone, so "B keeps it" is the whole assertion rather than a choice between two
    // ways of losing it (a tap on the surface dismisses it, by design).
    const pill = elementOf(second, 'selection-overlay')

    fireTouch('touchstart', [held], held.surface)
    one.posted.length = 0
    two.posted.length = 0
    // One finger, on B's own overlay, while A's is still down.
    fireTouch('touchstart', [held, { surface: pill, identifier: 1 }], pill)

    expect(pinchCancels(two.posted)).toHaveLength(0)
    expect(two.posted).toEqual([])

    one.started.stop()
    two.started.stop()
  })

  // The other side of the same read: on touchend the tap fires only when the last finger lifts, and
  // a finger resting in A made B's count non-zero forever.
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
