import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteParams
} from '../../../../src/navigation/workspace-execution-host'
import { useCallback } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { STANDALONE_SESSION_PARAM } from '../../../../src/navigation/host-stack-navigation'
import {
  SESSION_REQUEST_PARAMS,
  sessionScreenIdentity
} from '../../../../src/session/session-pane-intent'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/routing/shell-screen-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import type { BridgeClearableRouteParam } from '../../../../src/mobile-web-shell/bridge/page-lifecycle/bridge-route-update'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/presentation/PageRouteUnavailableScreen'

// paneKey selects a tab within the current session, not a new identity; remounting on it reloads the page and loses repeated taps.
// Deliver it as a route update via repeated init only to supporting pages, then clear the native param so later init cannot replay it (ruling 33.1).
export default withWorkspaceRoute(function MobileSessionScreen() {
  // Use firstParam for every query key; encoding String(array) could create a valid segment naming a nonexistent workspace.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    created?: string | string[]
    warning?: string | string[]
    homeDraft?: string | string[]
    paneKey?: string | string[]
    botItem?: string | string[]
    paneIntent?: string | string[]
    standalone?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const executionHost = useWorkspaceExecutionHost()
  const router = useRouter()
  const paneKey = firstParam(params.paneKey) ?? ''
  const botItem = firstParam(params.botItem) ?? ''
  const homeDraft = firstParam(params.homeDraft) ?? ''
  // Clear only the consumed request; a newer tap must survive.
  const eraseRequest = useCallback(
    (param: BridgeClearableRouteParam, value: string) => {
      const held: Partial<Record<BridgeClearableRouteParam, string>> = {
        paneKey,
        botItem,
        homeDraft
      }
      if (value === '' || value !== held[param]) {
        return
      }
      router.setParams({ [param]: '' })
    },
    [botItem, homeDraft, paneKey, router]
  )

  // Omit empty params: created=1 is one-shot, warning is host text, absent name derives a label, and empty paneKey marks a spent tap.
  const routeParams: Record<string, string> = {
    ...Object.fromEntries(
      (['name', 'created', 'warning', ...SESSION_REQUEST_PARAMS, STANDALONE_SESSION_PARAM] as const)
        .map((key) => [key, firstParam(params[key])] as const)
        .filter(([, value]) => value !== '')
    ),
    ...workspaceRouteParams(executionHost)
  }
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}`,
          ...(Object.keys(routeParams).length === 0 ? {} : { params: routeParams })
        })
      : null

  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Item and pane requests update the current page without discarding its bridge.
  // Keep shared shellScreenRouteKey unchanged because other screens treat param changes as identity changes.
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey({
        pathname: route.pathname,
        params: sessionScreenIdentity(routeParams)
      })}
      hostId={hostId}
      route={route}
      onRouteParamClear={eraseRequest}
    />
  )
})
