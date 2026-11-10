import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { View, type HostInstance } from 'react-native'
import {
  useMobileNativeChatLowerGeometry,
  useMobileNativeChatLowerRegion
} from '../mobile-native-chat-lower-region-context'
import {
  composerFieldAllowance,
  composerMenuReservation,
  type ComposerMenuIntrinsicSize
} from './mobile-native-chat-composer-menu-size'
import type {
  ComposerAllocation,
  ComposerAllocationProps
} from './MobileNativeChatComposerAllocation'

const AllocationContext = createContext<ComposerAllocation | null>(null)

export function useMobileNativeChatComposerAllocation() {
  return useContext(AllocationContext)
}

export function MobileNativeChatComposerAllocation({
  anchorRef,
  fieldRef,
  hasMenu,
  children
}: ComposerAllocationProps) {
  const { allocationHeight } = useMobileNativeChatLowerGeometry()
  const lower = useMobileNativeChatLowerRegion()
  const reserveRef = useRef<HostInstance>(null)
  const menuWasShown = useRef(false)
  const [active, setActive] = useState(false)
  const [intrinsic, setIntrinsic] = useState<ComposerMenuIntrinsicSize | null>(null)
  const [chrome, setChrome] = useState(0)
  const onIntrinsic = useCallback((next: ComposerMenuIntrinsicSize) => {
    setIntrinsic((current) =>
      current?.content === next.content &&
      current.chrome === next.chrome &&
      current.firstGroup === next.firstGroup
        ? current
        : next
    )
  }, [])
  useLayoutEffect(() => {
    const anchor: unknown = anchorRef.current
    const field: unknown = fieldRef.current
    if (!(anchor instanceof HTMLElement) || !(field instanceof HTMLElement)) {
      return
    }
    const group = anchor.closest<HTMLElement>('[data-testid="queued-card-editor"]') ?? anchor
    const measure = () => {
      const reserved: unknown = reserveRef.current
      const reservedHeight = reserved instanceof HTMLElement ? reserved.offsetHeight : 0
      if (group.offsetHeight > 0 && field.offsetHeight > 0) {
        setChrome(Math.max(0, group.offsetHeight - reservedHeight - field.offsetHeight))
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(group)
    observer.observe(field)
    return () => observer.disconnect()
  }, [anchorRef, fieldRef])
  const measured = lower && allocationHeight !== null
  const reservation =
    active && hasMenu && measured ? composerMenuReservation(intrinsic, allocationHeight, chrome) : 0
  const fieldMaxHeight = measured
    ? composerFieldAllowance(allocationHeight, chrome, reservation)
    : undefined
  useLayoutEffect(() => {
    lower?.layoutChanged()
    const anchor: unknown = anchorRef.current
    if (
      hasMenu !== menuWasShown.current &&
      anchor instanceof HTMLElement &&
      anchor.contains(anchor.ownerDocument.activeElement)
    ) {
      lower?.reveal(anchor, hasMenu ? 'menu' : 'edit')
    }
    menuWasShown.current = hasMenu
  })
  const value = useMemo(
    () => ({ reserveRef, reservation, fieldMaxHeight, onActiveChange: setActive, onIntrinsic }),
    [reservation, fieldMaxHeight, onIntrinsic]
  )
  return <AllocationContext value={value}>{children}</AllocationContext>
}

export function MobileNativeChatComposerMenuReservation() {
  const allocation = useMobileNativeChatComposerAllocation()
  return allocation ? (
    <View
      ref={allocation.reserveRef}
      pointerEvents="none"
      testID="native-chat-composer-menu-reservation"
      style={{ height: allocation.reservation, flexShrink: 0 }}
    />
  ) : null
}
