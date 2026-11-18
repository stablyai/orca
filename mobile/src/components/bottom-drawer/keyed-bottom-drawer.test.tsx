import { createElement, Profiler, useLayoutEffect, useState, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Record native Modal mount/unmount commits and sheets shown; iOS rejects second modal even while first closes, so lifecycle ordering matters.

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

  // Invalidate queued hide when sheet reopens before callback or it unmounts live sheet and swallows next close.
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
})
