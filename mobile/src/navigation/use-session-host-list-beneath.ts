import { useLayoutEffect, useRef } from 'react'
import { useNavigation } from 'expo-router'
import {
  sessionHostStackLevel,
  withHostSessionListBeneath,
  type HostStackNavigationState
} from './host-stack-navigation'

type SessionStackNavigation = {
  addListener: (event: 'state', listener: () => void) => () => void
  dispatch: (action: { type: 'RESET'; target?: string; payload: HostStackNavigationState }) => void
  getState: () => HostStackNavigationState | undefined
}

// Repair a native session opened with no host list under it. One attempt per host, so a rejected reset cannot loop.
export function useSessionHostListBeneath(hostId: string | null): void {
  const navigation = useNavigation<SessionStackNavigation>()
  const attemptedHost = useRef<string | null>(null)
  const seenHost = useRef(hostId)
  if (seenHost.current !== hostId) {
    seenHost.current = hostId
    attemptedHost.current = null
  }

  useLayoutEffect(() => {
    if (
      !hostId ||
      typeof navigation.getState !== 'function' ||
      typeof navigation.addListener !== 'function' ||
      typeof navigation.dispatch !== 'function'
    ) {
      return
    }
    const apply = () => {
      if (attemptedHost.current === hostId) {
        return
      }
      const state = navigation.getState()
      const level = state && sessionHostStackLevel(state, hostId)
      if (!level) {
        return
      }
      const next = withHostSessionListBeneath(level, hostId)
      // Mark before dispatch: the reset emits state, and a second insert would loop.
      attemptedHost.current = hostId
      if (!next) {
        return
      }
      navigation.dispatch({
        type: 'RESET',
        ...(level.key ? { target: level.key } : {}),
        payload: { ...level, index: next.index, routes: next.routes }
      })
    }
    apply()
    return navigation.addListener('state', apply)
  }, [hostId, navigation])
}
