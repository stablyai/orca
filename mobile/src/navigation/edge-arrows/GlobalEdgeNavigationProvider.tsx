import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useDirectionPadAvailable } from '../../layout/use-shell-side-rail'
import { subscribeMirroredKey } from '../../storage/mirrored-storage-keys'
import {
  getDefaultTerminalAccessoryLayout,
  loadTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference,
  saveTerminalAccessoryLayout,
  subscribeTerminalAccessoryLayoutChanges,
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
  type TerminalAccessoryLayout
} from '../../terminal/terminal-accessory-layout'
import {
  cycleEdgeNavigationMode,
  isEdgeSwitcherChipHidden,
  resolveEdgeNavigationMode,
  setTerminalEdgeNavigationMode,
  setTerminalEdgeSwitcherChipHidden,
  type EdgeNavigationMode
} from './edge-navigation-preference'
import {
  GlobalEdgeNavigationContext,
  type GlobalEdgeNavigationValue
} from './edge-navigation-state'

export function GlobalEdgeNavigationProvider({ children }: { children: ReactNode }) {
  const directionPadAvailable = useDirectionPadAvailable()
  const [layout, setLayout] = useState<TerminalAccessoryLayout>(() =>
    getDefaultTerminalAccessoryLayout(directionPadAvailable)
  )
  const layoutRef = useRef<TerminalAccessoryLayout>(layout)
  layoutRef.current = layout
  const [sheetVisible, setSheetVisible] = useState(false)

  useEffect(() => {
    let active = true
    void loadTerminalAccessoryLayout(directionPadAvailable).then((loaded) => {
      if (active) {
        layoutRef.current = loaded
        setLayout(loaded)
      }
    })
    const unsubscribeLocal = subscribeTerminalAccessoryLayoutChanges((next) => {
      layoutRef.current = next
      setLayout(next)
    })
    const unsubscribeMirror = subscribeMirroredKey(
      TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
      (rawValue) => {
        if (rawValue === null) {
          const fallback = getDefaultTerminalAccessoryLayout(directionPadAvailable)
          layoutRef.current = fallback
          setLayout(fallback)
          return
        }
        try {
          const parsed = normalizeTerminalAccessoryLayoutPreference(
            JSON.parse(rawValue),
            undefined,
            directionPadAvailable
          )
          layoutRef.current = parsed
          setLayout(parsed)
        } catch {
          // Ignore malformed external writes and keep current validated layout.
        }
      }
    )
    return () => {
      active = false
      unsubscribeLocal()
      unsubscribeMirror()
    }
  }, [directionPadAvailable])

  const persistUpdate = useCallback(
    (updater: (current: TerminalAccessoryLayout) => TerminalAccessoryLayout) => {
      const next = updater(layoutRef.current)
      layoutRef.current = next
      setLayout(next)
      void saveTerminalAccessoryLayout(next)
    },
    []
  )

  const mode = resolveEdgeNavigationMode(layout, directionPadAvailable)
  const switcherChipHidden = isEdgeSwitcherChipHidden(layout)

  const setMode = useCallback(
    (nextMode: EdgeNavigationMode) => {
      persistUpdate((current) => setTerminalEdgeNavigationMode(current, nextMode))
    },
    [persistUpdate]
  )

  const cycleMode = useCallback(() => {
    persistUpdate((current) => {
      const nextMode = cycleEdgeNavigationMode(
        resolveEdgeNavigationMode(current, directionPadAvailable)
      )
      return setTerminalEdgeNavigationMode(current, nextMode)
    })
  }, [directionPadAvailable, persistUpdate])

  const setSwitcherChipHidden = useCallback(
    (hidden: boolean) => {
      persistUpdate((current) => setTerminalEdgeSwitcherChipHidden(current, hidden))
    },
    [persistUpdate]
  )

  const value = useMemo<GlobalEdgeNavigationValue>(
    () => ({
      mode,
      switcherChipHidden,
      sheetVisible,
      setSheetVisible,
      setMode,
      cycleMode,
      setSwitcherChipHidden
    }),
    [mode, switcherChipHidden, sheetVisible, setMode, cycleMode, setSwitcherChipHidden]
  )

  return (
    <GlobalEdgeNavigationContext.Provider value={value}>
      {children}
    </GlobalEdgeNavigationContext.Provider>
  )
}
