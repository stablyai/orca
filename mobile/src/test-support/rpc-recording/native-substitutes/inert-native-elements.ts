import { createElement, type ReactNode } from 'react'

// Preserve host tags/props/children for projection, without layout or events.
// Drop render-callback children rather than inventing unscripted presses.
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
