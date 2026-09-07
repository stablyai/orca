import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState } from 'react-native'
import { DictationSetupPollController } from './dictation-setup-poll-controller'

type PollerOptions = {
  visible: boolean
  polling: boolean
  refresh: () => Promise<boolean | undefined>
  intervalMs: number
}

export function useDictationSetupPoller({
  visible,
  polling,
  refresh,
  intervalMs
}: PollerOptions): () => Promise<void> {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const poller = useMemo(
    () => new DictationSetupPollController(() => refreshRef.current(), intervalMs),
    [intervalMs]
  )

  useEffect(() => () => poller.dispose(), [poller])

  useEffect(() => {
    void poller.refreshNow()
  }, [poller, refresh])

  useEffect(() => {
    poller.setPolling(polling)
  }, [poller, polling])

  useEffect(() => {
    poller.setVisible(visible)
    if (!visible) {
      poller.setForeground(false)
      return undefined
    }

    poller.setForeground(AppState.currentState === 'active')
    const subscription = AppState.addEventListener('change', (state) => {
      poller.setForeground(state === 'active')
    })
    return () => {
      subscription.remove()
      poller.setVisible(false)
      poller.setForeground(false)
    }
  }, [poller, visible])

  return useCallback(() => poller.refreshNow(), [poller])
}
