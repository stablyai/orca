import type { Rectangle, View } from 'electron'
import { createOwnedViewHost } from './desktop-owned-browser-view-test-fixture'

export function createDesktopBrowserContainerFixture(): View {
  let bounds = { x: 0, y: 0, width: 1, height: 1 }
  let visible = false
  const shape = {
    ...createOwnedViewHost().contentView,
    setBounds: (value: Rectangle) => {
      bounds = { ...value }
    },
    getBounds: () => ({ ...bounds }),
    setVisible: (value: boolean) => {
      visible = value
    },
    getVisible: () => visible
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attachment tests use only this container's child ownership, bounds and visibility APIs.
  return shape as unknown as View
}
