import type { ReactNode } from 'react'
import type { AppState } from '../store/types'

export type ComponentFixture = {
  render: () => ReactNode
  /** Merged into the default-seeded app store before the first render. */
  store?: Partial<AppState>
  /** Runs after the store and `window.api` bridge exist, before render (e.g. stub an api call). */
  setup?: () => void
  /** Runs after first paint, e.g. click a trigger so an open popover is captured. */
  interact?: (frame: HTMLElement) => void | Promise<void>
  /** Frame width in CSS pixels; height always hugs the content. */
  width?: number
}

export type ComponentFixtureTheme = 'dark' | 'light'

export type ComponentFixtureModule = Record<string, unknown>

export function defineFixture(fixture: ComponentFixture): ComponentFixture {
  return fixture
}

export function isComponentFixture(value: unknown): value is ComponentFixture {
  return (
    typeof value === 'object' &&
    value !== null &&
    'render' in value &&
    typeof value.render === 'function'
  )
}
