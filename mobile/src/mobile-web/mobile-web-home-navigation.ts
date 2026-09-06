import { mobileAccountsRouteTarget } from '../accounts/mobile-accounts-route'
import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import { mobileTasksRouteTarget } from '../tasks/mobile-task-route'
import {
  MOBILE_WEB_NAVIGATION_INTENTS,
  type MobileWebNavigationIntent,
  type MobileWebNavigationIntentTarget
} from './mobile-web-navigation-intent-buffer'
import { MOBILE_NATIVE_BASELINE_MODE } from './mobile-native-baseline-mode'

type MobileHomeRouter = {
  push(target: string): void
}

/** The nested host-stack screen an intent lands on, or null when it resolves to the host
 *  index itself (which a plain push already reaches). */
export function mobileHomeHostStackTarget(
  hostId: string,
  target: MobileWebNavigationIntentTarget
): HostStackRouteTarget | null {
  if (target.kind === 'session') {
    return mobileSessionRouteTarget({
      hostId,
      worktreeId: target.hostWorkspaceId,
      name: target.name
    })
  }
  if (target.kind === 'tasks') {
    return mobileTasksRouteTarget(hostId, target.taskSource)
  }
  return target.kind === 'accounts' ? mobileAccountsRouteTarget(hostId) : null
}

export function navigateFromMobileHome(args: {
  router: MobileHomeRouter
  openHostStackRoute?: (hostId: string, target: HostStackRouteTarget) => void
  hostId: string
  target: MobileWebNavigationIntentTarget
  source?: MobileWebNavigationIntent['source']
  nativeBaselineEnabled?: boolean
}): void {
  const nativeBaselineEnabled = args.nativeBaselineEnabled ?? MOBILE_NATIVE_BASELINE_MODE
  MOBILE_WEB_NAVIGATION_INTENTS.publishHostTarget(args.hostId, args.target, args.source)
  const hostStackTarget = nativeBaselineEnabled
    ? mobileHomeHostStackTarget(args.hostId, args.target)
    : null
  // Why: a cold push into the nested host navigator resolves to the host index without the
  // dynamic id, so HostProtocolGate mounts blank — deep native routes must be coordinated (#12001).
  if (hostStackTarget && args.openHostStackRoute) {
    args.openHostStackRoute(args.hostId, hostStackTarget)
    return
  }
  args.router.push(mobileHomeDestination(args.hostId, args.target, nativeBaselineEnabled))
}

export function mobileHostWorkspaceEntry(
  hostId: string,
  nativeBaselineEnabled = MOBILE_NATIVE_BASELINE_MODE
): `/hybrid?hostId=${string}` | `/h/${string}` {
  const encodedHostId = encodeURIComponent(hostId)
  return nativeBaselineEnabled ? `/h/${encodedHostId}` : `/hybrid?hostId=${encodedHostId}`
}

export function mobileHomeDestination(
  hostId: string,
  target: MobileWebNavigationIntentTarget,
  nativeBaselineEnabled: boolean
): string {
  if (!nativeBaselineEnabled) {
    return mobileHostWorkspaceEntry(hostId, false)
  }
  const hostRoute = mobileHostWorkspaceEntry(hostId, true)
  if (target.kind === 'session') {
    return `${hostRoute}/session/${encodeURIComponent(target.hostWorkspaceId)}`
  }
  if (target.kind === 'tasks') {
    return target.taskSource
      ? `${hostRoute}/tasks?taskSource=${encodeURIComponent(target.taskSource)}`
      : `${hostRoute}/tasks`
  }
  if (target.kind === 'accounts') {
    return `${hostRoute}/accounts`
  }
  if (target.kind === 'newWorkspace') {
    return `${hostRoute}?action=newWorktree`
  }
  if (target.kind === 'workspaceList' && target.notice) {
    return `${hostRoute}?notice=${encodeURIComponent(target.notice)}`
  }
  return hostRoute
}
