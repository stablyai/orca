import {
  MobileWebClipboardAvailabilityPayloadSchema,
  MobileWebClipboardAvailabilityResultSchema,
  MobileWebClipboardWritePayloadSchema,
  MobileWebClipboardWriteResultSchema,
  MobileWebHapticFeedbackPayloadSchema,
  MobileWebHapticResultSchema,
  MobileWebHapticSelectionPayloadSchema,
  MobileWebHapticSelectionResultSchema,
  MobileWebNativeAlertPayloadSchema,
  MobileWebNativeAlertResultSchema,
  MobileWebOpenExternalPayloadSchema,
  MobileWebOpenExternalResultSchema,
  MobileWebSessionChatDraftReadPayloadSchema,
  MobileWebSessionChatDraftReadResultSchema,
  MobileWebSessionChatDraftWritePayloadSchema,
  MobileWebSessionChatDraftWriteResultSchema,
  MobileWebTerminalAccessoryPreferencesPayloadSchema,
  MobileWebTerminalAccessoryPreferencesResultSchema,
  MobileWebTerminalCustomKeysUpdatePayloadSchema,
  MobileWebTerminalCustomKeysUpdateResultSchema,
  MobileWebTerminalPreferencesPayloadSchema,
  MobileWebTerminalPreferencesResultSchema,
  MobileWebTerminalTextScaleUpdatePayloadSchema,
  MobileWebTerminalTextScaleUpdateResultSchema,
  type MobileWebClipboardWriteResult,
  type MobileWebClipboardAvailability,
  type MobileWebHapticKind,
  type MobileWebNativeAlertPayload,
  type MobileWebNativeAlertResult,
  type MobileWebSessionChatDraftReadResult,
  type MobileWebTerminalAccessoryPreferences,
  type MobileWebTerminalCustomKey,
  type MobileWebTerminalPreferences,
  type MobileWebTerminalTextScale
} from '../../shared/mobile-web/bridge-operation-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

// Human-owned native prompts must not inherit the ordinary RPC deadline.
const MOBILE_WEB_NATIVE_ALERT_REQUEST_TIMEOUT_MS = 2_147_483_647

export class MobileWebNativeRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  alert(payload: MobileWebNativeAlertPayload): Promise<MobileWebNativeAlertResult> {
    return this.requests.request(
      'native',
      'alert',
      payload,
      MobileWebNativeAlertPayloadSchema,
      MobileWebNativeAlertResultSchema,
      { timeoutMs: MOBILE_WEB_NATIVE_ALERT_REQUEST_TIMEOUT_MS }
    )
  }

  hapticSelection(): Promise<null> {
    return this.requests.request(
      'native',
      'hapticSelection',
      {},
      MobileWebHapticSelectionPayloadSchema,
      MobileWebHapticSelectionResultSchema
    )
  }

  hapticFeedback(kind: MobileWebHapticKind): Promise<null> {
    return this.requests.request(
      'native',
      'hapticFeedback',
      { kind },
      MobileWebHapticFeedbackPayloadSchema,
      MobileWebHapticResultSchema
    )
  }

  clipboardAvailability(): Promise<MobileWebClipboardAvailability> {
    return this.requests.request(
      'native',
      'clipboardAvailability',
      {},
      MobileWebClipboardAvailabilityPayloadSchema,
      MobileWebClipboardAvailabilityResultSchema
    )
  }

  clipboardWrite(text: string): Promise<MobileWebClipboardWriteResult> {
    return this.requests.request(
      'native',
      'clipboardWrite',
      { text },
      MobileWebClipboardWritePayloadSchema,
      MobileWebClipboardWriteResultSchema
    )
  }

  openExternal(url: string): Promise<null> {
    return this.requests.request(
      'native',
      'openExternal',
      { url },
      MobileWebOpenExternalPayloadSchema,
      MobileWebOpenExternalResultSchema
    )
  }

  terminalPreferences(): Promise<MobileWebTerminalPreferences> {
    return this.requests.request(
      'native',
      'terminalPreferences',
      {},
      MobileWebTerminalPreferencesPayloadSchema,
      MobileWebTerminalPreferencesResultSchema
    )
  }

  terminalAccessoryPreferences(): Promise<MobileWebTerminalAccessoryPreferences> {
    return this.requests.request(
      'native',
      'terminalAccessoryPreferences',
      {},
      MobileWebTerminalAccessoryPreferencesPayloadSchema,
      MobileWebTerminalAccessoryPreferencesResultSchema
    )
  }

  terminalCustomKeysUpdate(customKeys: readonly MobileWebTerminalCustomKey[]): Promise<null> {
    return this.requests.request(
      'native',
      'terminalCustomKeysUpdate',
      { customKeys },
      MobileWebTerminalCustomKeysUpdatePayloadSchema,
      MobileWebTerminalCustomKeysUpdateResultSchema
    )
  }

  terminalTextScaleUpdate(textScale: MobileWebTerminalTextScale): Promise<null> {
    return this.requests.request(
      'native',
      'terminalTextScaleUpdate',
      { textScale },
      MobileWebTerminalTextScaleUpdatePayloadSchema,
      MobileWebTerminalTextScaleUpdateResultSchema
    )
  }

  sessionChatDraftRead(
    workspaceId: string,
    tabId: string
  ): Promise<MobileWebSessionChatDraftReadResult> {
    return this.requests.request(
      'native',
      'sessionChatDraftRead',
      { workspaceId, tabId },
      MobileWebSessionChatDraftReadPayloadSchema,
      MobileWebSessionChatDraftReadResultSchema
    )
  }

  sessionChatDraftWrite(workspaceId: string, tabId: string, text: string): Promise<null> {
    return this.requests.request(
      'native',
      'sessionChatDraftWrite',
      { workspaceId, tabId, text },
      MobileWebSessionChatDraftWritePayloadSchema,
      MobileWebSessionChatDraftWriteResultSchema
    )
  }
}
