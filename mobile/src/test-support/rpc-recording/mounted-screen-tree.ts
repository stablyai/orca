import { Component, createElement, type ReactElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { MountContext } from './recording-scenario'

type CrashProps = { onCrash: (message: string) => void; children?: ReactNode }

// Record render/effect crashes as screen outcomes so malformed reply partitions remain observable.
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

// Rebuild elements on updates to reflect changed props.
// Send crashes to the effect sink too; it forces a cleanup checkpoint even when adapters omit crash state.
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

// Read inert element props directly; lists never render rows unless an adapter drives them.
export function renderedElementProps(tree: unknown, tag: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  walk(tree, (node) => {
    if (typeof node !== 'string' && node.type === tag) {
      found.push(node.props)
    }
  })
  return found
}

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

export function projectMountedScreen(screen: { tree: () => unknown; crash: () => string | null }): {
  elements: Record<string, number>
  text: string[]
  labels: string[]
  crash: string | null
} {
  return { ...projectScreenTree(screen.tree()), crash: screen.crash() }
}

// Project primitives, text and labels; callbacks/styles are unrecordable and do not describe screen outcomes.
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
