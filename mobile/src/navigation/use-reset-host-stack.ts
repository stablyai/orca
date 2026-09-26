import { useCallback } from 'react'
import { useNavigation } from 'expo-router'
import type { MobileSessionRouteParams } from '../session/mobile-session-route'
import {
  hostStackResetAction,
  rootHostSwitchAction,
  type HostStackResetAction,
  type RootHostSwitchAction,
  type RootStackState
} from './host-stack-reset'

export type ResetHostStack = (
  hostId: string,
  session?: Omit<MobileSessionRouteParams, 'hostId'>
) => void

type HostStackNavigation = {
  dispatch: (action: HostStackResetAction) => void
  getParent: () =>
    | {
        dispatch: (action: RootHostSwitchAction) => void
        getState: () => RootStackState | undefined
      }
    | undefined
}

/** Swaps the host stack in one dispatch, so switching machines never stacks a second host. */
export function useResetHostStack(currentHostId: string): ResetHostStack {
  const navigation = useNavigation<HostStackNavigation>()
  return useCallback(
    (hostId, session) => {
      const root = hostId === currentHostId ? undefined : navigation.getParent()
      const rootState = root?.getState()
      const rootAction = rootState && rootHostSwitchAction(rootState, hostId, session)
      if (root && rootAction) {
        root.dispatch(rootAction)
        return
      }
      navigation.dispatch(hostStackResetAction(hostId, session))
    },
    [currentHostId, navigation]
  )
}
