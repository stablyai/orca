import { useEffect, useState } from 'react'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeShellMessage,
  type MobileWebNavigationRoute,
  type MobileWebResumeRoute
} from '../../../src/shared/mobile-web/bridge-contract'
import type { ConnectionState, HostProfile } from '../transport/types'
import { mobileWebBridgeErrorCode } from './mobile-web-broker-error'
import type { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import {
  MOBILE_WEB_NAVIGATION_INTENTS,
  type MobileWebNavigationIntent
} from './mobile-web-navigation-intent-buffer'

type ShellContext = {
  sessionId: string
  buildId: string
}

export function useMobileWebNavigationIntentHandoff(options: {
  hosts: readonly HostProfile[]
  hostsLoading: boolean
  selectedHostId: string | undefined
  connectionState: ConnectionState
  shellContext: ShellContext | null
  pageReadySessionId: string | undefined
  brokerSessionId: string | undefined
  getBroker: () => MobileWebCapabilityBroker | null
  selectHost: (hostId: string | undefined) => void
  refreshHosts: () => Promise<void>
  postMessage: (message: MobileWebBridgeShellMessage) => Promise<void>
  rememberRoute: (route: MobileWebResumeRoute) => void
  onNavigationResolved?: (intent: MobileWebNavigationIntent, route: MobileWebResumeRoute) => void
  showWarning: (message: string, code?: string) => void
}): void {
  const [intent, setIntent] = useState<MobileWebNavigationIntent | null>(null)
  const activeIntent =
    intent && MOBILE_WEB_NAVIGATION_INTENTS.isCurrent(intent.sequence) ? intent : null

  useEffect(
    () =>
      MOBILE_WEB_NAVIGATION_INTENTS.subscribe((next) => {
        setIntent(next)
        options.selectHost(next.hostId)
        void options.refreshHosts()
      }),
    [options.refreshHosts, options.selectHost]
  )

  useEffect(() => {
    if (
      !intent ||
      options.hostsLoading ||
      options.hosts.some((host) => host.id === intent.hostId)
    ) {
      return
    }
    if (MOBILE_WEB_NAVIGATION_INTENTS.consume(intent.sequence)) {
      options.selectHost(undefined)
    }
  }, [intent, options.hosts, options.hostsLoading, options.selectHost])

  useEffect(() => {
    const context = options.shellContext
    if (
      !activeIntent ||
      !context ||
      options.selectedHostId !== activeIntent.hostId ||
      options.connectionState !== 'connected' ||
      options.pageReadySessionId !== context.sessionId ||
      options.brokerSessionId !== context.sessionId
    ) {
      return
    }
    const broker = options.getBroker()
    if (!broker) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const route = await resolveIntentRoute(activeIntent, broker)
        if (
          cancelled ||
          !MOBILE_WEB_NAVIGATION_INTENTS.isCurrent(activeIntent.sequence) ||
          options.getBroker() !== broker
        ) {
          return
        }
        if (route.kind === 'workspaceList' || route.kind === 'session') {
          options.rememberRoute(route)
          options.onNavigationResolved?.(activeIntent, route)
        }
        await options.postMessage({
          version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
          type: 'navigation',
          shellSessionId: context.sessionId,
          buildId: context.buildId,
          sequence: activeIntent.sequence,
          route
        })
        if (!cancelled && MOBILE_WEB_NAVIGATION_INTENTS.consume(activeIntent.sequence)) {
          setIntent(null)
        }
      } catch (error) {
        if (!cancelled && MOBILE_WEB_NAVIGATION_INTENTS.consume(activeIntent.sequence)) {
          setIntent(null)
          options.showWarning(
            `${navigationIntentFailureSubject(activeIntent.source)} couldn’t be opened.`,
            mobileWebBridgeErrorCode(error)
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    activeIntent,
    options.brokerSessionId,
    options.connectionState,
    options.getBroker,
    options.onNavigationResolved,
    options.pageReadySessionId,
    options.postMessage,
    options.rememberRoute,
    options.selectedHostId,
    options.shellContext,
    options.showWarning
  ])
}

async function resolveIntentRoute(
  intent: MobileWebNavigationIntent,
  broker: MobileWebCapabilityBroker
): Promise<MobileWebNavigationRoute> {
  if (intent.target.kind === 'session') {
    return broker.resolveNavigationRoute(intent.target.hostWorkspaceId)
  }
  if (intent.target.kind === 'tasks') {
    return {
      kind: 'tasks',
      ...(intent.target.taskSource ? { taskSource: intent.target.taskSource } : {})
    }
  }
  return intent.target
}

function navigationIntentFailureSubject(source: MobileWebNavigationIntent['source']): string {
  if (source === 'coldResume') {
    return 'Previous workspace'
  }
  return source === 'notification' ? 'Notification destination' : 'Destination'
}
