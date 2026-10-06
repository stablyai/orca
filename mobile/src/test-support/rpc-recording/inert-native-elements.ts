import { createElement, type ReactNode } from 'react'

/**
 * A native view a recording renders but never operates.
 *
 * It renders its children and keeps every other prop on the test tree, where a projection can read
 * what the screen chose to pass, and it does nothing else: no prop of its own is ever invoked, no
 * layout is measured, and no event is fired. The name becomes the host tag, so which primitive a
 * screen reached for is part of the observation rather than lost in a generic wrapper.
 *
 * Children that are a render callback — `Pressable`'s pressed-state form — are dropped rather than
 * called, because calling one would be the recording inventing a press nobody scripted.
 */
export function inertNativeElement(name: string) {
  function InertNativeElement(props: { children?: ReactNode }): ReactNode {
    const { children, ...rest } = props
    return createElement(name, rest, typeof children === 'function' ? undefined : children)
  }
  InertNativeElement.displayName = name
  return InertNativeElement
}

/** One inert element per name, built once so React sees a stable component identity per render. */
export function inertNativeElements(names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, inertNativeElement(name)]))
}

/**
 * A package whose entire export surface is icon components, answered with one inert element per
 * name. There is no "rest" to refuse here the way a partial module refuses one: an unlisted member
 * of an icon set is another icon, so enumerating the set would only pin the package's contents.
 * Memoised because an icon rebuilt per render would remount the subtree it labels.
 */
export function inertIconModule(): unknown {
  const icons = new Map<string, unknown>()
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (typeof key !== 'string' || key === '__esModule') {
          return undefined
        }
        const found = icons.get(key)
        if (found) {
          return found
        }
        const icon = inertNativeElement(key)
        icons.set(key, icon)
        return icon
      }
    }
  )
}
