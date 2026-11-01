import { useEffect } from 'react'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { publishTerminalViewAttributesAtAppStart } from '../components/terminal-pane/terminal-appearance'
import { subscribeToPublishedTerminalViewAttributes } from '../components/terminal-pane/terminal-view-attributes-publisher'
import { remoteRuntimeTerminalColorPush } from '../runtime/remote-runtime-terminal-color-push'
import { useAppStore } from '../store'

/** Reports this window's terminal theme to its own host and to every paired host. */
export function useTerminalViewerColorPublication(): void {
  const settings = useAppStore((s) => s.settings)

  // Publish without open panes so hosts receive theme changes; deduplication makes unrelated preference edits free.
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
    const unsubscribe = subscribeToPublishedTerminalViewAttributes(
      remoteRuntimeTerminalColorPush.setAttributes
    )
    window.addEventListener('focus', remoteRuntimeTerminalColorPush.pushToAllHosts)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', remoteRuntimeTerminalColorPush.pushToAllHosts)
    }
  }, [])
}
