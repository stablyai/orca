import { Redirect, useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'

// The Pull Request view is now a segment of the Source Control hub. This route
// stays as a thin redirect so existing deep links land on the hub with the Pull
// Request segment selected. The wide-layout dock opens the same hub with
// initialTab="pr" (SessionDockColumn), not this route.
export default function PrRedirect() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
  }>()
  return (
    <Redirect
      href={{
        pathname: '/h/[hostId]/source-control/[worktreeId]',
        params: {
          hostId: firstParam(params.hostId),
          worktreeId: firstParam(params.worktreeId),
          name: firstParam(params.name),
          origin: firstParam(params.origin),
          tab: 'pr'
        }
      }}
    />
  )
}
