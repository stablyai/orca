import { MobileSourceControlPanel } from '../../../../src/source-control/MobileSourceControlPanel'
import { useMobileWebRouteParams } from '../../../../src/mobile-web/use-mobile-web-route-params'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'
import { parseSourceControlHubTab } from '../../../../src/source-control/mobile-source-control-hub-tab'
import type { HostSourceControlBinding } from '../../../../src/source-control/host-source-control-binding'

export function MobileSourceControlRoute({
  binding,
  routeName,
  routeOrigin
}: {
  binding?: HostSourceControlBinding
  routeName?: string
  routeOrigin?: string
} = {}) {
  const params = useMobileWebRouteParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
    tab?: string | string[]
  }>()
  return (
    <MobileSourceControlPanel
      hostId={firstParam(params.hostId)}
      worktreeId={firstParam(params.worktreeId)}
      name={routeName ?? firstParam(params.name)}
      origin={routeOrigin ?? firstParam(params.origin)}
      initialTab={parseSourceControlHubTab(params.tab)}
      embedded={false}
      binding={binding}
    />
  )
}

export default function MobileSourceControlScreen() {
  return <MobileSourceControlRoute />
}
