import { Component, createElement, type ReactElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { MountContext } from './recording-scenario'

type CrashProps = { onCrash: (message: string) => void; children?: ReactNode }

/**
 * A screen that throws while rendering or in an effect is a recording, not a suite failure: it is
 * what a reply partition does to a device, and refusing to record it would leave the shapes that
 * break a screen the only ones the oracle cannot see. The boundary catches it, the subtree goes,
 * and the message becomes state.
 */
class MountedScreenCrash extends Component<CrashProps, { crash: string | null }> {
  state: { crash: string | null } = { crash: null }
  static getDerivedStateFromError(error: unknown): { crash: string } {
    return { crash: error instanceof Error ? error.message : String(error) }
  }
  componentDidCatch(error: unknown): void {
    this.props.onCrash(error instanceof Error ? error.message : String(error))
  }
  render(): ReactNode {
    return this.state.crash === null ? this.props.children : null
  }
}

/**
 * A mounted screen, rather than a mounted hook. The element is rebuilt on every mount and update so
 * an adapter can change a prop between steps the way a parent screen would.
 *
 * The crash goes to the effect sink as well as to `crash()`, because an adapter that projects no
 * crash — every hook mount, whose state is the hook's own value — would otherwise record a screen
 * that quietly stopped rendering. An effect is not optional in the same way: it forces a cleanup
 * checkpoint, so the crash reaches the golden without the adapter cooperating.
 */
export function screenMount(element: () => ReactElement, effect: MountContext['effect']) {
  let renderer: ReactTestRenderer | undefined
  let crashed: string | null = null
  const wrapped = () =>
    createElement(
      MountedScreenCrash,
      {
        onCrash: (message: string) => {
          crashed = message
          effect('screen.crash', { message })
        }
      },
      element()
    )
  return {
    mount() {
      act(() => {
        renderer = create(wrapped())
      })
    },
    update() {
      act(() => {
        renderer?.update(wrapped())
      })
    },
    unmount() {
      act(() => {
        renderer?.unmount()
        renderer = undefined
        crashed = null
      })
    },
    tree: (): unknown => renderer?.toJSON() ?? null,
    crash: (): string | null => crashed
  }
}

/** The hook form of `screenMount`: the same crash boundary, over a harness that draws nothing. */
export function hookScreenMount(
  render: () => void,
  effect: MountContext['effect']
): ReturnType<typeof screenMount> {
  function Harness(): null {
    render()
    return null
  }
  return screenMount(() => createElement(Harness), effect)
}

type RenderedNode = { type: string; props: Record<string, unknown>; children: unknown[] | null }

/**
 * The props one inert element was rendered with. Nothing invokes an inert element's callbacks, so a
 * list's contents are only ever observable through the data it was handed; this is how an adapter
 * reads them without the recording pretending a row was drawn.
 */
export function renderedElementProps(tree: unknown, tag: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  walk(tree, (node) => {
    if (typeof node !== 'string' && node.type === tag) {
      found.push(node.props)
    }
  })
  return found
}

/** One depth-first pass in render order, over the host nodes and the text between them. */
function walk(node: unknown, visit: (node: RenderedNode | string) => void): void {
  if (typeof node === 'string') {
    visit(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit)
    }
    return
  }
  if (!node || typeof node !== 'object' || !('type' in node)) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: react-test-renderer's JSON nodes carry exactly these three fields.
  const rendered = node as RenderedNode
  visit(rendered)
  walk(rendered.children, visit)
}

/** What a mounted screen rendered, and the crash instead if a reply took it down. */
export function projectMountedScreen(screen: { tree: () => unknown; crash: () => string | null }): {
  elements: Record<string, number>
  text: string[]
  labels: string[]
  crash: string | null
} {
  return { ...projectScreenTree(screen.tree()), crash: screen.crash() }
}

/**
 * Which inert primitives a screen chose, the copy it put on them, and the labels it gave them.
 *
 * Deliberately not the whole tree. A projection is an observation, and the props a screen passes
 * include callbacks and style objects that are neither recordable nor behaviour — but the element
 * census is what distinguishes a spinner from a list from an error, the text is what a person would
 * read off the screen, and the labels are the affordances. A screen that stops rendering its rows,
 * or blanks its copy, moves all three.
 */
function projectScreenTree(tree: unknown): {
  elements: Record<string, number>
  text: string[]
  labels: string[]
} {
  const elements: Record<string, number> = {}
  const text: string[] = []
  const labels: string[] = []
  walk(tree, (node) => {
    if (typeof node === 'string') {
      text.push(node)
      return
    }
    elements[node.type] = (elements[node.type] ?? 0) + 1
    const label = node.props.accessibilityLabel
    if (typeof label === 'string') {
      labels.push(label)
    }
  })
  return { elements, text, labels }
}
