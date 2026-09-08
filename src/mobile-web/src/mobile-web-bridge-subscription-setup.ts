import {
  MobileWebTerminalRequestSchema,
  MobileWebTerminalEventSchema,
  type MobileWebTerminalRequest,
  type MobileWebTerminalEvent
} from '../../shared/mobile-web/terminal-stream-contract'
import type { z } from 'zod'
import type { MobileWebBridgeCapability } from '../../shared/mobile-web/bridge-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import {
  MobileWebSpeechEventSchema,
  MobileWebSpeechSubscribePayloadSchema,
  type MobileWebSpeechEvent
} from '../../shared/mobile-web/speech-operation-contract'

export type MobileWebBridgeSubscriptionSetup = {
  operation?: string
  capability: MobileWebBridgeCapability
  payload: unknown
  payloadSchema: z.ZodType<unknown>
  eventSchema: z.ZodType<unknown>
  onEvent: (value: unknown) => void
  onError: (error: MobileWebBridgeClientError) => void
}

export function speechSubscriptionSetup(
  onEvent: (event: MobileWebSpeechEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'speech',
    payload: {},
    payloadSchema: MobileWebSpeechSubscribePayloadSchema,
    eventSchema: MobileWebSpeechEventSchema,
    onEvent: (value) => onEvent(value as MobileWebSpeechEvent),
    onError
  }
}

export function terminalSubscriptionSetup(
  payload: Extract<MobileWebTerminalRequest, { operation: 'subscribe' }>,
  onEvent: (event: MobileWebTerminalEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'terminal',
    payload,
    payloadSchema: MobileWebTerminalRequestSchema,
    eventSchema: MobileWebTerminalEventSchema,
    onEvent: (value) => onEvent(value as MobileWebTerminalEvent),
    onError
  }
}
