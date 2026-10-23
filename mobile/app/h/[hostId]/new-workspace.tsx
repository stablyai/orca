import { Redirect, useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../src/navigation/route-param-reader'
import { newWorkspaceOverlayHref } from '../../../src/new-workspace/new-workspace-overlay-route'

/**
 * Natively this path is the overlay over the screen that asked for it; the page's file is the
 * drawer that overlay hosts.
 */
export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  return <Redirect href={newWorkspaceOverlayHref([firstParam(params.hostId)])} />
}
