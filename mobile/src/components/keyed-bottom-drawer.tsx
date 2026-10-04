import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { MountedBottomDrawer, type MountedBottomDrawerProps } from './mounted-bottom-drawer'

// iOS cannot present a native Modal while another is still presented, even mid-close, so one
// drawer owns what is on screen and swaps sheets only after the previous Modal has unmounted.

type Props<T> = Omit<MountedBottomDrawerProps, 'visible' | 'onClose' | 'onHidden' | 'children'> & {
  /** The sheet the screen wants shown, or null for none. */
  sheet: T | null
  /** Sheets with the same key are one presentation: new content refreshes it in place. */
  sheetKey: (sheet: T) => string
  onClose: (presented: T) => void
  /** Runs once a sheet's Modal has unmounted, in the commit after it left the tree. */
  onAfterClose?: (closed: T) => void
  children: (presented: T) => ReactNode
}

type Presentation<T> = {
  presented: T | null
  /** The presented sheet is animating closed. */
  closing: boolean
  /** Just unmounted; nothing may present until a commit without its Modal has landed. */
  released: T | null
  /** Identifies one mounted Modal so a hide from an earlier one cannot close a later one. */
  epoch: number
}

export function KeyedBottomDrawer<T>({
  sheet,
  sheetKey,
  onClose,
  onAfterClose,
  children,
  ...drawerProps
}: Props<T>) {
  const [state, setState] = useState<Presentation<T>>(() => ({
    presented: sheet,
    closing: false,
    released: null,
    epoch: 0
  }))
  const onAfterCloseRef = useRef(onAfterClose)
  useEffect(() => {
    onAfterCloseRef.current = onAfterClose
  }, [onAfterClose])

  const next = followRequest(state, sheet, sheetKey)
  // Why: present in the same render as the request so opening does not add a blank commit.
  if (next !== state) {
    setState(next)
  }

  const { epoch, released } = next
  const handleHidden = useCallback(() => {
    // Why: a hide that finished before a reopen re-showed this sheet must not unmount it.
    setState((current) =>
      current.epoch === epoch && current.closing
        ? { presented: null, closing: false, released: current.presented, epoch: epoch + 1 }
        : current
    )
  }, [epoch])

  useEffect(() => {
    if (released === null) {
      return
    }
    onAfterCloseRef.current?.(released)
    setState((current) =>
      current.released === released ? { ...current, released: null } : current
    )
  }, [released])

  const presented = next.presented
  if (presented === null) {
    return null
  }
  return (
    <MountedBottomDrawer
      {...drawerProps}
      visible={!next.closing}
      onClose={() => onClose(presented)}
      onHidden={handleHidden}
    >
      {children(presented)}
    </MountedBottomDrawer>
  )
}

function followRequest<T>(
  state: Presentation<T>,
  sheet: T | null,
  sheetKey: (sheet: T) => string
): Presentation<T> {
  const { presented } = state
  if (presented === null) {
    return sheet !== null && state.released === null
      ? { ...state, presented: sheet, closing: false }
      : state
  }
  if (sheet !== null && sheetKey(sheet) === sheetKey(presented)) {
    return sheet !== presented || state.closing
      ? { ...state, presented: sheet, closing: false }
      : state
  }
  return state.closing ? state : { ...state, closing: true }
}
