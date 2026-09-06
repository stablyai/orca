import { onTestFinished } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgePageMessage,
  MOBILE_WEB_SHELL_FEATURES,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgeMessageContext,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import type { MobileWebCapabilityBrokerOptions } from './mobile-web-capability-broker-options'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'

type InitMessage = Extract<MobileWebBridgeShellMessage, { type: 'init' }>

export const MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

export function createMobileWebBridgeRoundtripFixture(options: {
  grants: InitMessage['grants']
  /** Defaults to what the hybrid screen really advertises; pass [] to model an older shell. */
  shellFeatures?: readonly string[]
  rpcClient?: RpcClient | null
  context?: MobileWebBridgeMessageContext
  createRequestId?: () => string
  nativeAuthority?: Partial<MobileWebNativeCapabilityAuthority>
  navigationAuthority?: MobileWebNavigationAuthority
  isActive?: () => boolean
  isConnected?: () => boolean
  terminalClientId?: string
  randomBytes?: (length: number) => Uint8Array
}) {
  const context = options.context ?? MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT
  const pageMessages: MobileWebBridgePageMessage[] = []
  const shellMessages: MobileWebBridgeShellMessage[] = []
  let broker: MobileWebCapabilityBroker
  const client = new MobileWebBridgeClient({
    context,
    grants: options.grants,
    shellFeatures: options.shellFeatures ?? MOBILE_WEB_SHELL_FEATURES,
    createRequestId: options.createRequestId,
    postMessage(message) {
      const parsed = parseMobileWebBridgePageMessage(JSON.stringify(message), context)
      if (!parsed.ok) {
        return false
      }
      pageMessages.push(parsed.value)
      void broker.handle(parsed.value)
      return true
    }
  })
  broker = new MobileWebCapabilityBroker({
    context,
    getClient: () => options.rpcClient ?? null,
    isConnected: options.isConnected ?? (() => options.rpcClient != null),
    isActive: options.isActive ?? (() => true),
    nativeAuthority: { ...defaultNativeAuthority(), ...options.nativeAuthority },
    navigationAuthority: options.navigationAuthority,
    terminalClientId: options.terminalClientId ?? 'roundtrip-device',
    randomBytes: options.randomBytes ?? ((length) => new Uint8Array(length).fill(1)),
    postMessage(message) {
      const parsed = parseMobileWebBridgeShellMessage(JSON.stringify(message), context)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      shellMessages.push(parsed.value)
      client.receive(parsed.value)
    }
  })
  const dispose = () => {
    client.dispose()
    broker.dispose()
  }
  onTestFinished(dispose)
  return { broker, client, dispose, pageMessages, shellMessages }
}

function defaultNativeAuthority(): MobileWebNativeCapabilityAuthority {
  return {
    alert: async () => ({ kind: 'dismissed' }),
    hapticFeedback: () => {},
    clipboardAvailability: async () => ({ hasText: false, hasImage: false }),
    clipboardWrite: async () => ({ confirmation: 'in-app' }),
    openExternal: async () => {},
    terminalPreferences: async () => ({
      textScale: 1,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser'
    }),
    terminalTextScaleUpdate: async () => {}
  }
}

type PageRequestMessage = Extract<MobileWebBridgePageMessage, { type: 'request' }>
type PageCancelMessage = Extract<MobileWebBridgePageMessage, { type: 'cancel' }>

// Broker-only harness: page messages go in as-is, shell messages land unparsed in `messages`.
export function createMobileWebBrokerFixture(
  overrides: Partial<Omit<MobileWebCapabilityBrokerOptions, 'nativeAuthority'>> & {
    nativeAuthority?: Partial<MobileWebNativeCapabilityAuthority>
  } = {}
): { broker: MobileWebCapabilityBroker; messages: MobileWebBridgeShellMessage[] } {
  const messages: MobileWebBridgeShellMessage[] = []
  const { nativeAuthority, ...rest } = overrides
  const broker = new MobileWebCapabilityBroker({
    context: MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT,
    getClient: () => null,
    isConnected: () => true,
    isActive: () => true,
    postMessage: (message) => {
      messages.push(message)
    },
    nativeAuthority: {
      ...stubbedNativeAuthority(),
      ...nativeAuthority
    } as MobileWebNativeCapabilityAuthority,
    terminalClientId: 'device-token',
    randomBytes: (length) => new Uint8Array(length).fill(1),
    ...rest
  })
  return { broker, messages }
}

export function mobileWebBridgeRequestMessage(options: {
  requestId: string
  capability: string
  operation: string
  payload: unknown
  subscriptionId?: string
  context?: MobileWebBridgeMessageContext
}): PageRequestMessage {
  const context = options.context ?? MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'request',
    ...context,
    requestId: options.requestId,
    ...(options.subscriptionId === undefined
      ? { mode: 'once' }
      : { mode: 'subscription', subscriptionId: options.subscriptionId }),
    capability: options.capability,
    operation: options.operation,
    payload: options.payload
  } as PageRequestMessage
}

export function mobileWebBridgeCancelMessage(options: {
  target: 'request' | 'subscription'
  id: string
  context?: MobileWebBridgeMessageContext
}): PageCancelMessage {
  const context = options.context ?? MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'cancel',
    ...context,
    target: options.target,
    id: options.id
  }
}

// Only the members every broker-only suite stubs; each suite opts into the rest it exercises.
function stubbedNativeAuthority(): Partial<MobileWebNativeCapabilityAuthority> {
  return {
    hapticFeedback: () => {},
    clipboardWrite: async () => ({ confirmation: 'in-app' }),
    openExternal: async () => {},
    terminalPreferences: async () => ({
      textScale: 1,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser'
    }),
    terminalTextScaleUpdate: async () => {}
  }
}
