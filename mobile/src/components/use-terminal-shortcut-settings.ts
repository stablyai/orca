import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { CustomKey } from '../storage/terminal-custom-key-storage'
import type { TerminalShortcutPreferences } from '../terminal/terminal-settings-operations'
import { TERMINAL_ACCESSORY_KEYS } from '../terminal/terminal-accessory-keys'
import {
  getDefaultTerminalAccessoryLayout,
  reorderTerminalAccessoryBuiltInIds,
  setTerminalAccessoryBuiltInVisible,
  type TerminalAccessoryLayout
} from '../terminal/terminal-accessory-layout'

export function useTerminalShortcutSettings(preferences: TerminalShortcutPreferences) {
  const [loadedKeys, setLoadedKeys] = useState(false)
  const [loadedLayout, setLoadedLayout] = useState(false)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [customKeys, setCustomKeys] = useState<CustomKey[]>([])
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const [shortcutLayout, setShortcutLayout] = useState<TerminalAccessoryLayout>(
    getDefaultTerminalAccessoryLayout
  )
  const layoutWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const layoutWriteSeqRef = useRef(0)
  const pendingLayoutWritesRef = useRef(0)

  const persistLayout = useCallback(
    (next: TerminalAccessoryLayout) => {
      setPendingWrites((count) => count + 1)
      setError(null)
      layoutWriteSeqRef.current += 1
      pendingLayoutWritesRef.current += 1
      layoutWriteChainRef.current = layoutWriteChainRef.current
        .catch(() => {})
        .then(() => preferences.saveLayout(next))
        .catch(async () => {
          setError('Could not save shortcut layout. Try again.')
          try {
            setShortcutLayout(await preferences.loadLayout())
          } catch {
            setLoadedLayout(false)
          }
        })
        .finally(() => {
          pendingLayoutWritesRef.current -= 1
          setPendingWrites((count) => count - 1)
        })
    },
    [preferences]
  )

  const refreshShortcutLayout = useCallback(() => {
    const refreshSeq = layoutWriteSeqRef.current
    void preferences
      .loadLayout()
      .then((layout) => {
        if (pendingLayoutWritesRef.current > 0 || refreshSeq !== layoutWriteSeqRef.current) {
          return
        }
        setLoadedLayout(true)
        setShortcutLayout({
          orderedBuiltInIds: layout.orderedBuiltInIds,
          visibleBuiltInIds: layout.visibleBuiltInIds
        })
      })
      .catch(() => setError('Could not load shortcut layout. Go back and try again.'))
  }, [preferences])

  const customKeysWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const customKeysWriteSeqRef = useRef(0)
  const pendingCustomKeysWritesRef = useRef(0)

  // Why: same stale-snapshot guard as persistLayout — a focus/AppState refresh
  // racing an in-flight save must not overwrite the optimistic state.
  const persistCustomKeys = useCallback(
    (next: CustomKey[]) => {
      setPendingWrites((count) => count + 1)
      setError(null)
      customKeysWriteSeqRef.current += 1
      pendingCustomKeysWritesRef.current += 1
      customKeysWriteChainRef.current = customKeysWriteChainRef.current
        .catch(() => {})
        .then(() => preferences.saveKeys(next))
        .catch(async () => {
          setError('Could not save custom shortcuts. Try again.')
          try {
            setCustomKeys(await preferences.loadKeys())
          } catch {
            setLoadedKeys(false)
          }
        })
        .finally(() => {
          pendingCustomKeysWritesRef.current -= 1
          setPendingWrites((count) => count - 1)
        })
    },
    [preferences]
  )

  const refreshCustomKeys = useCallback(() => {
    const refreshSeq = customKeysWriteSeqRef.current
    void preferences
      .loadKeys()
      .then((keys) => {
        if (
          pendingCustomKeysWritesRef.current > 0 ||
          refreshSeq !== customKeysWriteSeqRef.current
        ) {
          return
        }
        setLoadedKeys(true)
        setCustomKeys(keys)
      })
      .catch(() => setError('Could not load custom shortcuts. Go back and try again.'))
  }, [preferences])

  const handleDeleteCustomKey = useCallback(
    (key: CustomKey) => {
      const updated = customKeys.filter((entry) => entry.id !== key.id)
      setCustomKeys(updated)
      persistCustomKeys(updated)
    },
    [customKeys, persistCustomKeys]
  )

  useFocusEffect(
    useCallback(() => {
      refreshShortcutLayout()
      refreshCustomKeys()
    }, [refreshShortcutLayout, refreshCustomKeys])
  )

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refreshShortcutLayout()
        refreshCustomKeys()
      }
    })
    return () => sub.remove()
  }, [refreshShortcutLayout, refreshCustomKeys])

  const toggleBuiltInKey = useCallback(
    (id: string, visible: boolean) => {
      const next = setTerminalAccessoryBuiltInVisible(shortcutLayout, id, visible)
      setShortcutLayout(next)
      persistLayout(next)
    },
    [shortcutLayout, persistLayout]
  )
  const reorderBuiltInKeys = useCallback(
    (orderedKeys: string[]) => {
      const next = reorderTerminalAccessoryBuiltInIds(shortcutLayout, orderedKeys)
      setShortcutLayout(next)
      persistLayout(next)
    },
    [shortcutLayout, persistLayout]
  )
  const resetBuiltInKeys = useCallback(() => {
    const next = getDefaultTerminalAccessoryLayout()
    setShortcutLayout(next)
    persistLayout(next)
  }, [persistLayout])

  const reorderCustomKeys = useCallback(
    (orderedKeys: string[]) => {
      const byId = new Map(customKeys.map((key) => [key.id, key]))
      const reordered = orderedKeys.flatMap((id) => {
        const key = byId.get(id)
        return key ? [key] : []
      })
      if (reordered.length !== customKeys.length) {
        return
      }
      setCustomKeys(reordered)
      persistCustomKeys(reordered)
    },
    [customKeys, persistCustomKeys]
  )
  const visibleBuiltInSet = useMemo(
    () => new Set(shortcutLayout.visibleBuiltInIds),
    [shortcutLayout.visibleBuiltInIds]
  )
  const orderedAccessoryKeys = useMemo(() => {
    const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
    return shortcutLayout.orderedBuiltInIds.flatMap((id) => {
      const key = byId.get(id)
      return key ? [key] : []
    })
  }, [shortcutLayout.orderedBuiltInIds])

  return {
    busy: !loadedKeys || !loadedLayout || pendingWrites > 0,
    error,
    customKeys,
    showCustomKeyModal,
    setShowCustomKeyModal,
    shortcutLayout,
    visibleBuiltInSet,
    orderedAccessoryKeys,
    handleDeleteCustomKey,
    toggleBuiltInKey,
    reorderBuiltInKeys,
    resetBuiltInKeys,
    reorderCustomKeys,
    customKeysWriteSeqRef,
    setCustomKeys
  }
}
