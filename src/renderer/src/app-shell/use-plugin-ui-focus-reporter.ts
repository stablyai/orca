import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { derivePluginUiFocusReport } from '../lib/plugin-ui-focus-report'

const REPORT_DEBOUNCE_MS = 100

function publishPluginUiFocus(payload: ReturnType<typeof derivePluginUiFocusReport>): void {
  window.api?.plugins?.reportUiFocus?.(payload)
  void window.api?.runtime
    ?.call?.({ method: 'plugins.reportUiFocus', params: payload })
    .catch(() => undefined)
}

/** Pushes the focused UI surface to the plugin host (local IPC + runtime RPC). */
export function usePluginUiFocusReporter(): void {
  const activeModal = useAppStore((state) => state.activeModal)
  const activeTabType = useAppStore((state) => state.activeTabType)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const unifiedTabsByWorktree = useAppStore((state) => state.unifiedTabsByWorktree)
  const groupsByWorktree = useAppStore((state) => state.groupsByWorktree)
  const activeGroupIdByWorktree = useAppStore((state) => state.activeGroupIdByWorktree)
  const windowFocusedRef = useRef(typeof document === 'undefined' ? true : document.hasFocus())

  useEffect(() => {
    let timer = 0
    const flush = (windowFocused: boolean): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        publishPluginUiFocus(
          derivePluginUiFocusReport({
            windowFocused,
            activeModal,
            activeTabType,
            activeWorktreeId,
            unifiedTabsByWorktree,
            groupsByWorktree,
            activeGroupIdByWorktree
          })
        )
      }, REPORT_DEBOUNCE_MS)
    }

    flush(windowFocusedRef.current)
    const onFocus = (): void => {
      windowFocusedRef.current = true
      flush(true)
    }
    const onBlur = (): void => {
      windowFocusedRef.current = false
      flush(false)
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      window.clearTimeout(timer)
    }
  }, [
    activeModal,
    activeTabType,
    activeWorktreeId,
    unifiedTabsByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree
  ])
}
