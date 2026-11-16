import { Redirect, useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../src/navigation/route-param-reader'
import { newWorkspaceOverlayHref } from '../../../src/new-workspace/new-workspace-overlay-route'

// Native overlay hosts the page’s Create Workspace drawer over its caller.
export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  return <Redirect href={newWorkspaceOverlayHref([firstParam(params.hostId)])} />
}
