import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import type {
  BridgeBrowserViewEnding,
  BridgeBrowserViewFrame
} from '../mobile-web-shell/bridge/bridge-native-verbs'
import type { ShellLocalBrowser } from '../platform/shell-local-browser-types'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import { mobileBrowserPaneStyles } from './mobile-browser-pane-styles'

type Props = {
  placed: NonNullable<ShellLocalBrowser['placed']>
  worktreeId: string
  url: string
  viewMode: MobileBrowserViewMode
  onEnded: (ending: BridgeBrowserViewEnding) => void
  onRefused: (error: unknown) => void
}

let nextPlacementId = 0
const FOLLOW_INTERVAL_MS = 100

const HIDDEN_FRAME: BridgeBrowserViewFrame = { x: 0, y: 0, width: 0, height: 0 }

function domElement(node: unknown): HTMLElement | null {
  return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement ? node : null
}

// A sheet or menu the page opens over the pane would sit under the native view, so it hides while one covers the
// pane's middle; checking corners too would hide it under small floating controls.
function covered(element: HTMLElement, rect: DOMRect): boolean {
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return hit !== null && hit !== element && !element.contains(hit)
}

function measure(element: HTMLElement): BridgeBrowserViewFrame {
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || covered(element, rect)) {
    return HIDDEN_FRAME
  }
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

function sameFrame(a: BridgeBrowserViewFrame, b: BridgeBrowserViewFrame): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Holds the pane's place in a served page while the app draws the tab over it in a native web view. */
export function MobileBrowserPlacedLocal({
  placed,
  worktreeId,
  url,
  viewMode,
  onEnded,
  onRefused
}: Props): React.JSX.Element {
  const ref = useRef<View>(null)
  const callbacks = useRef({ onEnded, onRefused })
  callbacks.current = { onEnded, onRefused }
  // The tab's first page and layout only: the native view follows its own navigation from there.
  const opening = useRef({ url, viewMode })

  useEffect(() => {
    const element = domElement(ref.current)
    if (!element) {
      return
    }
    let active = true
    let frame = measure(element)
    const id = `placed-${++nextPlacementId}`
    void placed.show({ id, worktreeId, ...opening.current, frame }).then(
      (ending) => {
        if (active) {
          callbacks.current.onEnded(ending)
        }
      },
      (error: unknown) => {
        if (active) {
          callbacks.current.onRefused(error)
        }
      }
    )
    // The pane moves with the page's layout, keyboard and sidebars, none of which report to it. Resizes answer at
    // once; a slow poll catches moves and covering sheets without hit-testing every frame.
    const follow = (): void => {
      const next = measure(element)
      if (!sameFrame(next, frame)) {
        frame = next
        void placed.move(id, next).catch(() => {})
      }
    }
    const poll = setInterval(follow, FOLLOW_INTERVAL_MS)
    const resizes = new ResizeObserver(follow)
    resizes.observe(element)
    window.addEventListener('resize', follow)
    return () => {
      active = false
      clearInterval(poll)
      resizes.disconnect()
      window.removeEventListener('resize', follow)
      void placed.remove(id).catch(() => {})
    }
  }, [placed, worktreeId])

  return <View ref={ref} style={mobileBrowserPaneStyles.root} />
}
