import { Redirect, useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'

// History is now a segment of the Source Control hub. This route stays as a thin
// redirect so existing deep links (and any cached navigation) land on the hub with
// the History segment selected.
export default function HistoryRedirect() {
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
          tab: 'history'
        }
      }}
    />
  )
}
