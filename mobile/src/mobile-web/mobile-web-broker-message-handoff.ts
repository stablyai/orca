import type { RefObject } from 'react'
import type { MobileWebShellViewRef } from '@orca/expo-mobile-web-shell'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import {
  completeMobileWebNativeRouteHandoffAfterResponse,
  type MobileWebNativeRoute,
  type MobileWebNativeRouteHandoff
} from './mobile-web-native-route-handoff'

export async function handleMobileWebBrokerMessage(args: {
  message: MobileWebBridgePageMessage
  brokerRef: RefObject<MobileWebCapabilityBroker | null>
  activeSessionIdRef: RefObject<string | undefined>
  sessionId: string
  viewRef: RefObject<MobileWebShellViewRef | null>
  routeHandoff: MobileWebNativeRouteHandoff
  setHostedViewActive: (active: boolean) => void
  navigateToNativeRoute: (destination: MobileWebNativeRoute) => void
  onNavigationFailure: (destination: MobileWebNativeRoute) => void
}): Promise<void> {
  const broker = args.brokerRef.current
  await broker?.handle(args.message)
  if (
    args.message.type !== 'request' ||
    !broker ||
    args.brokerRef.current !== broker ||
    args.activeSessionIdRef.current !== args.sessionId
  ) {
    return
  }
  completeMobileWebNativeRouteHandoffAfterResponse({
    handoff: args.routeHandoff,
    requestId: args.message.requestId,
    shouldNavigate: () =>
      args.brokerRef.current === broker && args.activeSessionIdRef.current === args.sessionId,
    deactivateSessionView: async () => {
      const view = args.viewRef.current
      if (!view) {
        throw new Error('mobile_web_session_view_unavailable')
      }
      await view.deactivateSessionView()
    },
    setHostedViewActive: args.setHostedViewActive,
    navigate: args.navigateToNativeRoute,
    onFailure: (_error, destination) => args.onNavigationFailure(destination)
  })
}
