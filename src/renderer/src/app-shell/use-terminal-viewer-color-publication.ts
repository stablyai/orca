import { useEffect } from 'react'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { publishTerminalViewAttributesAtAppStart } from '../components/terminal-pane/terminal-appearance'
import { subscribeToPublishedTerminalViewColors } from '../components/terminal-pane/terminal-view-attributes-publisher'
import { remoteRuntimeTerminalColorPush } from '../runtime/remote-runtime-terminal-color-push'
import { useAppStore } from '../store'

/** Reports this window's terminal theme to its own host and to every paired host. */
export function useTerminalViewerColorPublication(): void {
  const settings = useAppStore((s) => s.settings)

  // Why: panes publish only when they apply appearance, so with none open a theme change
  // would never reach the hosts. The publisher dedupes, so an unrelated settings edit is free.
  useEffect(() => {
    if (!settings) {
      return
    }
    const publish = (): void => {
      publishTerminalViewAttributesAtAppStart(settings, getSystemPrefersDark())
    }
    publish()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', publish)
    return () => mq.removeEventListener('change', publish)
  }, [settings])

  useEffect(() => {
    const unsubscribe = subscribeToPublishedTerminalViewColors(
      remoteRuntimeTerminalColorPush.setColors
    )
    window.addEventListener('focus', remoteRuntimeTerminalColorPush.pushToAllHosts)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', remoteRuntimeTerminalColorPush.pushToAllHosts)
    }
  }, [])
}
