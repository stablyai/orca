import type { z } from 'zod'
import type { MobileWebBridgeCapability } from '../../shared/mobile-web/bridge-contract'
import {
  MobileWebAccountEventSchema,
  MobileWebAccountSubscribePayloadSchema,
  type MobileWebAccountEvent
} from '../../shared/mobile-web/account-operation-contract'
import {
  MobileWebNativeChatEventSchema,
  MobileWebNativeChatSubscribePayloadSchema,
  MobileWebSessionSnapshotResultSchema,
  MobileWebSessionSubscribePayloadSchema,
  type MobileWebNativeChatEvent,
  type MobileWebNativeChatSubscribePayload,
  type MobileWebSessionSnapshotResult,
  type MobileWebSessionSubscribePayload,
  MobileWebWorkspaceChangeSchema,
  MobileWebWorkspaceSubscribePayloadSchema,
  type MobileWebWorkspaceChange
} from '../../shared/mobile-web/bridge-operation-contract'
import {
  MobileWebSourceControlStatusInvalidationSchema,
  MobileWebSourceControlSubscribePayloadSchema,
  type MobileWebSourceControlStatusInvalidation,
  type MobileWebSourceControlSubscribePayload
} from '../../shared/mobile-web/source-control-operation-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import {
  MobileWebBrowserEventSchema,
  MobileWebBrowserStreamPayloadSchema,
  type MobileWebBrowserEvent,
  type MobileWebBrowserStreamPayload
} from '../../shared/mobile-web/browser-operation-contract'
import {
  MobileWebSpeechEventSchema,
  MobileWebSpeechSubscribePayloadSchema,
  type MobileWebSpeechEvent
} from '../../shared/mobile-web/speech-operation-contract'

export type MobileWebBridgeSubscriptionSetup = {
  capability: MobileWebBridgeCapability
  payload: unknown
  payloadSchema: z.ZodType<unknown>
  eventSchema: z.ZodType<unknown>
  onEvent: (value: unknown) => void
  onError: (error: MobileWebBridgeClientError) => void
}

export function sessionSubscriptionSetup(
  payload: MobileWebSessionSubscribePayload,
  onEvent: (event: MobileWebSessionSnapshotResult) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'session',
    payload,
    payloadSchema: MobileWebSessionSubscribePayloadSchema,
    eventSchema: MobileWebSessionSnapshotResultSchema.refine(
      (event) => event.workspaceId === payload.workspaceId
    ),
    onEvent: (value) => onEvent(value as MobileWebSessionSnapshotResult),
    onError
  }
}

export function nativeChatSubscriptionSetup(
  payload: MobileWebNativeChatSubscribePayload,
  onEvent: (event: MobileWebNativeChatEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'nativeChat',
    payload,
    payloadSchema: MobileWebNativeChatSubscribePayloadSchema,
    eventSchema: MobileWebNativeChatEventSchema,
    onEvent: (value) => onEvent(value as MobileWebNativeChatEvent),
    onError
  }
}

export function accountSubscriptionSetup(
  onEvent: (event: MobileWebAccountEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'account',
    payload: {},
    payloadSchema: MobileWebAccountSubscribePayloadSchema,
    eventSchema: MobileWebAccountEventSchema,
    onEvent: (value) => onEvent(value as MobileWebAccountEvent),
    onError
  }
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

export function browserSubscriptionSetup(
  payload: MobileWebBrowserStreamPayload,
  onEvent: (event: MobileWebBrowserEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'browser',
    payload,
    payloadSchema: MobileWebBrowserStreamPayloadSchema,
    eventSchema: MobileWebBrowserEventSchema,
    onEvent: (value) => onEvent(value as MobileWebBrowserEvent),
    onError
  }
}

export function workspaceSubscriptionSetup(
  onEvent: (event: MobileWebWorkspaceChange) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'workspace',
    payload: {},
    payloadSchema: MobileWebWorkspaceSubscribePayloadSchema,
    eventSchema: MobileWebWorkspaceChangeSchema,
    onEvent: (value) => onEvent(value as MobileWebWorkspaceChange),
    onError
  }
}

export function sourceControlSubscriptionSetup(
  payload: MobileWebSourceControlSubscribePayload,
  onEvent: (event: MobileWebSourceControlStatusInvalidation) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'sourceControl',
    payload,
    payloadSchema: MobileWebSourceControlSubscribePayloadSchema,
    eventSchema: MobileWebSourceControlStatusInvalidationSchema.refine(
      (event) => event.workspaceId === payload.workspaceId
    ),
    onEvent: (value) => onEvent(value as MobileWebSourceControlStatusInvalidation),
    onError
  }
}
