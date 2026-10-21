import { createElement, Profiler, useLayoutEffect, useState, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// iOS cannot present a native Modal while another is still presented, even mid-close. Each mounted
// MountedBottomDrawer is one native Modal; this mock records when each mounts and unmounts, in which
// commit, and which sheets it ever showed, so the tests can check the drawer's lifecycle directly.

type Drawer = {
  id: number
  keys: Set<string>
  visible: boolean
  onHidden: () => void
  onClose: () => void
}
type Event = { type: 'mount' | 'unmount'; id: number; commit: number }

type Modals = {
  commit: number
  nextId: number
  all: Drawer[]
  live: Map<number, Drawer>
  events: Event[]
}

const modals = vi.hoisted((): Modals => ({
  commit: 0,
  nextId: 0,
  all: [],
  live: new Map(),
  events: []
}))

vi.mock('./mounted-bottom-drawer', () => ({
  MountedBottomDrawer: function MockMountedBottomDrawer(props: {
    visible: boolean
    onHidden: () => void
    onClose: () => void
    children: ReactElement<{ name: string }>
  }) {
    const [drawer] = useState((): Drawer => ({ id: modals.nextId++, keys: new Set(), ...props }))
    useLayoutEffect(() => {
      drawer.visible = props.visible
      drawer.onHidden = props.onHidden
      drawer.onClose = props.onClose
      drawer.keys.add(props.children.props.name)
    })
    useLayoutEffect(() => {
      modals.all.push(drawer)
      modals.live.set(drawer.id, drawer)
      modals.events.push({ type: 'mount', id: drawer.id, commit: modals.commit })
      return () => {
        modals.live.delete(drawer.id)
        modals.events.push({ type: 'unmount', id: drawer.id, commit: modals.commit })
      }
    }, [])
    return props.children
  }
}))

const { KeyedBottomDrawer } = await import('./keyed-bottom-drawer')

type Sheet = { name: string; version: number }

let renderer: ReactTestRenderer | null = null
let onAfterClose: Mock<(closed: Sheet) => void>

function tree(sheet: Sheet | null, onClose: (presented: Sheet) => void = () => {}): ReactElement {
  return (
    <Profiler
      id="drawer"
      // Why: runs once per commit after its subtree's layout effects, so it numbers commits.
      onRender={() => {
        modals.commit++
      }}
    >
      <KeyedBottomDrawer<Sheet>
        sheet={sheet}
        sheetKey={(s) => s.name}
        onClose={onClose}
        onAfterClose={onAfterClose}
      >
        {(presented) =>
          createElement('SheetContent', { name: presented.name, version: presented.version })
        }
      </KeyedBottomDrawer>
    </Profiler>
  )
}

function request(sheet: Sheet | null): void {
  act(() => {
    if (renderer) {
      renderer.update(tree(sheet))
    } else {
      renderer = create(tree(sheet))
    }
  })
}

function only(): Drawer | null {
  expect(modals.live.size).toBeLessThanOrEqual(1)
  return [...modals.live.values()][0] ?? null
}

function presented(): { name: string; version: number; visible: boolean } | null {
  const drawer = only()
  if (!drawer) {
    return null
  }
  const content = renderer!.root.find((node) => String(node.type) === 'SheetContent')
  return { name: content.props.name, version: content.props.version, visible: drawer.visible }
}

/** The native hide animation of the mounted drawer finished. */
function finishHide(drawer = only()): void {
  act(() => drawer?.onHidden())
}

function mounts(): Event[] {
  return modals.events.filter((event) => event.type === 'mount')
}

const A = { name: 'a', version: 1 }
const B = { name: 'b', version: 1 }
const C = { name: 'c', version: 1 }

beforeEach(() => {
  modals.commit = 0
  modals.nextId = 0
  modals.all = []
  modals.live.clear()
  modals.events = []
  onAfterClose = vi.fn()
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('KeyedBottomDrawer', () => {
  it('presents a request at once when nothing is presented', () => {
    request(null)
    expect(presented()).toBeNull()
    request(A)
    expect(presented()).toEqual({ name: 'a', version: 1, visible: true })
  })

  it('hides the presented sheet and shows the next only after its Modal has unmounted', () => {
    request(A)
    request(B)
    // A keeps its content through the close; B is not mounted yet.
    expect(presented()).toEqual({ name: 'a', version: 1, visible: false })

    finishHide()
    expect(presented()).toEqual({ name: 'b', version: 1, visible: true })
    expect(onAfterClose).toHaveBeenCalledExactlyOnceWith(A)

    const unmountA = modals.events.find((event) => event.type === 'unmount')
    const mountB = mounts()[1]!
    // A commit with no Modal at all lands between A leaving and B arriving.
    expect(mountB.commit).toBeGreaterThan(unmountA!.commit)
  })

  it('presents the latest request after a close, never one replaced before it was shown', () => {
    request(A)
    request(B)
    request(C)
    finishHide()
    expect(presented()?.name).toBe('c')
    expect(modals.all.map((drawer) => [...drawer.keys])).toEqual([['a'], ['c']])
  })

  it('a request cleared before the close finishes presents nothing afterwards', () => {
    request(A)
    request(B)
    request(null)
    finishHide()
    expect(presented()).toBeNull()
    expect(mounts()).toHaveLength(1)
  })

  it('reopening the same sheet mid-close re-shows the same Modal with the new content', () => {
    request(A)
    const drawer = only()
    request(null)
    expect(presented()?.visible).toBe(false)
    request({ name: 'a', version: 2 })
    expect(presented()).toEqual({ name: 'a', version: 2, visible: true })
    expect(only()).toBe(drawer)
    expect(mounts()).toHaveLength(1)
  })

  it('switching away and back to the presented sheet mid-close re-shows it', () => {
    request(A)
    request(B)
    request(A)
    expect(presented()).toEqual({ name: 'a', version: 1, visible: true })
    finishHide()
    expect(presented()?.visible).toBe(true)
    expect(mounts()).toHaveLength(1)
  })

  // The hide animation finishes, the sheet reopens before the scheduled JS callback runs, and then
  // the callback lands: it must not unmount the shown sheet or swallow the next close.
  it('ignores a hide that lands after a reopen and still honours the next close', () => {
    request(A)
    const drawer = only()!
    request(null)
    request(A)
    finishHide(drawer)
    expect(presented()).toEqual({ name: 'a', version: 1, visible: true })
    expect(onAfterClose).not.toHaveBeenCalled()

    request(B)
    finishHide()
    expect(presented()).toEqual({ name: 'b', version: 1, visible: true })
    expect(onAfterClose).toHaveBeenCalledExactlyOnceWith(A)
  })

  it('a hide from an earlier Modal cannot close a later one', () => {
    request(A)
    const first = only()!
    request(null)
    finishHide()
    request(B)
    request(null)
    act(() => first.onHidden())
    expect(presented()).toEqual({ name: 'b', version: 1, visible: false })
    finishHide()
    expect(presented()).toBeNull()
  })

  it('reports the close with the sheet that was presented', () => {
    const onClose = vi.fn()
    act(() => {
      renderer = create(tree({ name: 'a', version: 3 }, onClose))
    })
    act(() => only()?.onClose())
    expect(onClose).toHaveBeenCalledExactlyOnceWith({ name: 'a', version: 3 })
  })

  it('keeps one Modal, never swaps its sheet, and always settles on the latest request', () => {
    const names = ['a', 'b', 'c']
    let seed = 11
    const random = (n: number) => {
      seed = (seed * 48271) % 2147483647
      return seed % n
    }
    let latestName: string | null = null
    let version = 0
    for (let step = 0; step < 600; step++) {
      const move = random(5)
      if (move === 2) {
        finishHide()
      } else if (move === 3) {
        // A stale or early hide from whichever Modal is up.
        act(() => only()?.onHidden())
      } else {
        // A new request, or the same sheet again with fresh content.
        const pick = random(names.length + 1)
        latestName = move === 4 ? latestName : (names[pick] ?? null)
        request(latestName === null ? null : { name: latestName, version: ++version })
      }
      const shown = presented()
      if (shown?.visible) {
        expect(shown.name).toBe(latestName)
      }
    }
    // Settle: finishing every pending hide lands on the latest request.
    for (let i = 0; i < 3; i++) {
      if (presented()?.visible === false) {
        finishHide()
      }
    }
    expect(presented()?.name ?? null).toBe(latestName)

    expect(modals.all.length).toBeGreaterThan(20)
    for (const drawer of modals.all) {
      expect(drawer.keys.size).toBe(1)
    }
    // Each Modal mounted in a later commit than the one before it left.
    const ordered = modals.events
    for (let i = 1; i < ordered.length; i++) {
      const event = ordered[i]!
      if (event.type === 'mount') {
        const previous = ordered[i - 1]!
        expect(previous.type).toBe('unmount')
        expect(event.commit).toBeGreaterThan(previous.commit)
      }
    }
  })
})
