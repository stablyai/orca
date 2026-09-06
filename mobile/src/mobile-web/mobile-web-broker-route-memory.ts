import type { MobileWebResumeRoute } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebCapabilityBrokerOptions } from './mobile-web-capability-broker-options'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export function rememberMobileWebBrokerRoute(
  active: boolean,
  route: MobileWebResumeRoute,
  workspaceAuthority: MobileWebWorkspaceAuthority,
  options: Pick<MobileWebCapabilityBrokerOptions, 'rememberHostRoute' | 'rememberRoute'>
): void {
  if (!active) {
    return
  }
  if (route.kind === 'session') {
    let hostWorkspaceId: string
    try {
      hostWorkspaceId = workspaceAuthority.hostWorkspaceId(route.workspaceId)
    } catch {
      return
    }
    options.rememberHostRoute?.({ kind: 'session', hostWorkspaceId })
  } else {
    options.rememberHostRoute?.({ kind: 'workspaceList' })
  }
  options.rememberRoute?.(route)
}
