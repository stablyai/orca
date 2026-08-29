import { useCallback } from 'react'
import { useNavigation } from 'expo-router'
import {
  convergeOnMountedHostStackRoute,
  type HostStackRootNavigation
} from '../navigation/host-stack-navigation'
import { mobileSessionRouteTarget, type MobileSessionRouteParams } from './mobile-session-route'

/** Returns true when the session was already mounted and has now been focused, so the
 *  caller must not run its own push/replace: that is what mounts the second screen for
 *  one worktree, and the two then contend for the single (terminal, client) input lease. */
export function useConvergeOnMountedSession(): (params: MobileSessionRouteParams) => boolean {
  const navigation = useNavigation<HostStackRootNavigation>()

  return useCallback(
    (params) => convergeOnMountedHostStackRoute(navigation, mobileSessionRouteTarget(params)),
    [navigation]
  )
}
