import * as Clipboard from 'expo-clipboard'
import * as ExpoCrypto from 'expo-crypto'
import { Linking, Platform } from 'react-native'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'
import {
  normalizeMobileWebExternalUrl,
  type MobileWebClipboardAvailability,
  type MobileWebClipboardWriteResult,
  type MobileWebHapticKind,
  type MobileWebNativeAlertPayload,
  type MobileWebNativeAlertResult,
  type MobileWebTerminalAccessoryPreferences,
  type MobileWebTerminalCustomKey,
  type MobileWebTerminalPreferences,
  type MobileWebTerminalTextScale
} from '../../../src/shared/mobile-web/native-operation-contract'
import {
  triggerEdgeBump,
  triggerError,
  triggerMediumImpact,
  triggerSelection,
  triggerSuccess
} from '../platform/haptics'
import {
  loadTerminalAutocompleteEnabled,
  loadTerminalLinkOpenMode,
  loadTerminalTextScale,
  saveTerminalTextScale
} from '../storage/preferences'
import { loadCustomKeys, saveCustomKeys } from '../storage/terminal-custom-key-storage'
import { loadTerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import {
  loadMobileSessionChatDraft,
  saveMobileSessionChatDraft
} from '../storage/mobile-session-chat-drafts'
import {
  loadMobileSessionChatPendingDeliveries,
  saveMobileSessionChatPendingDeliveries,
  type MobileSessionChatPendingDelivery
} from '../storage/mobile-session-chat-pending-deliveries'
import {
  loadMobileSessionMarkdownDraft,
  saveMobileSessionMarkdownDraft,
  type MobileSessionMarkdownDraft
} from '../storage/mobile-session-markdown-drafts'
import {
  requestCodexResetCredit,
  type CodexResetCreditRequestResult
} from '../components/codex-reset-credit'
import { readCodexResetCreditCapability } from '../components/codex-reset-credit-capability'
import type { RpcClient } from '../transport/rpc-client'
import { mobileWebNativeAlertLifecycle } from './mobile-web-native-alert'

type MobileWebNativeDraftScope = {
  hostIdentity: string
  buildIdentity: string
}

export type MobileWebNativeCapabilityAuthority = {
  alert?: (payload: MobileWebNativeAlertPayload) => Promise<MobileWebNativeAlertResult>
  hapticFeedback: (kind: MobileWebHapticKind) => void
  clipboardAvailability: () => Promise<MobileWebClipboardAvailability>
  clipboardWrite: (text: string) => Promise<MobileWebClipboardWriteResult>
  openExternal: (url: string) => Promise<void>
  terminalPreferences: () => Promise<MobileWebTerminalPreferences>
  terminalAccessoryPreferences?: () => Promise<MobileWebTerminalAccessoryPreferences>
  terminalCustomKeysUpdate?: (customKeys: readonly MobileWebTerminalCustomKey[]) => Promise<void>
  terminalTextScaleUpdate: (textScale: MobileWebTerminalTextScale) => Promise<void>
  codexResetCreditCapability?: (client: Pick<RpcClient, 'sendRequest'>) => Promise<boolean>
  codexResetCreditConsume?: (
    client: Pick<RpcClient, 'sendRequest'>,
    expectedScope: CodexResetCreditExpectedScope
  ) => Promise<CodexResetCreditRequestResult>
  sessionChatDraftRead?: (workspaceId: string, tabId: string) => Promise<string>
  sessionChatDraftWrite?: (workspaceId: string, tabId: string, text: string) => Promise<void>
  sessionChatPendingRead?: (
    workspaceId: string,
    tabId: string,
    providerSessionId: string
  ) => Promise<MobileSessionChatPendingDelivery[]>
  sessionChatPendingWrite?: (
    workspaceId: string,
    tabId: string,
    providerSessionId: string,
    deliveries: readonly MobileSessionChatPendingDelivery[]
  ) => Promise<void>
  sessionMarkdownDraftRead?: (
    workspaceId: string,
    tabId: string,
    relativePath: string
  ) => Promise<MobileSessionMarkdownDraft | null>
  sessionMarkdownDraftWrite?: (
    workspaceId: string,
    tabId: string,
    relativePath: string,
    draft: MobileSessionMarkdownDraft | null
  ) => Promise<void>
}

export function createMobileWebNativeCapabilityAuthority(
  draftScope: MobileWebNativeDraftScope,
  alert: NonNullable<
    MobileWebNativeCapabilityAuthority['alert']
  > = mobileWebNativeAlertLifecycle.present
): MobileWebNativeCapabilityAuthority {
  return {
    alert,
    hapticFeedback(kind) {
      if (kind === 'selection') {
        triggerSelection()
      } else if (kind === 'success') {
        triggerSuccess()
      } else if (kind === 'error') {
        triggerError()
      } else if (kind === 'edge-bump') {
        triggerEdgeBump()
      } else {
        triggerMediumImpact()
      }
    },
    async clipboardAvailability() {
      const [hasText, hasImage] = await Promise.all([
        Clipboard.hasStringAsync().catch(() => false),
        Clipboard.hasImageAsync().catch(() => false)
      ])
      return { hasText, hasImage }
    },
    async clipboardWrite(text) {
      await Clipboard.setStringAsync(text)
      return { confirmation: Platform.OS === 'ios' ? 'in-app' : 'system' }
    },
    async openExternal(url) {
      const externalUrl = normalizeMobileWebExternalUrl(url)
      if (!externalUrl) {
        throw new Error('Unsupported external URL')
      }
      await Linking.openURL(externalUrl)
    },
    async terminalPreferences() {
      const [textScale, autocompleteEnabled, linkOpenMode] = await Promise.all([
        loadTerminalTextScale(),
        loadTerminalAutocompleteEnabled(),
        loadTerminalLinkOpenMode()
      ])
      return {
        textScale: textScale as MobileWebTerminalTextScale,
        autocompleteEnabled,
        linkOpenMode
      }
    },
    async terminalAccessoryPreferences() {
      const [customKeys, layout] = await Promise.all([
        loadCustomKeys(),
        loadTerminalAccessoryLayout()
      ])
      return {
        customKeys,
        orderedBuiltInIds: layout.orderedBuiltInIds,
        visibleBuiltInIds: layout.visibleBuiltInIds
      }
    },
    async terminalCustomKeysUpdate(customKeys) {
      await saveCustomKeys([...customKeys])
    },
    async terminalTextScaleUpdate(textScale) {
      await saveTerminalTextScale(textScale)
    },
    codexResetCreditCapability(client) {
      return readCodexResetCreditCapability(client)
    },
    codexResetCreditConsume(client, expectedScope) {
      return requestCodexResetCredit(client, {
        hostId: draftScope.hostIdentity,
        expectedScope,
        createIdempotencyKey: () => ExpoCrypto.randomUUID()
      })
    },
    sessionChatDraftRead(workspaceId, tabId) {
      return loadMobileSessionChatDraft({
        ...draftScope,
        workspaceIdentity: workspaceId,
        tabIdentity: tabId
      })
    },
    sessionChatDraftWrite(workspaceId, tabId, text) {
      return saveMobileSessionChatDraft(
        {
          ...draftScope,
          workspaceIdentity: workspaceId,
          tabIdentity: tabId
        },
        text
      )
    },
    sessionChatPendingRead(workspaceId, tabId, providerSessionId) {
      return loadMobileSessionChatPendingDeliveries({
        ...draftScope,
        workspaceIdentity: workspaceId,
        tabIdentity: tabId,
        providerSessionIdentity: providerSessionId
      })
    },
    sessionChatPendingWrite(workspaceId, tabId, providerSessionId, deliveries) {
      return saveMobileSessionChatPendingDeliveries(
        {
          ...draftScope,
          workspaceIdentity: workspaceId,
          tabIdentity: tabId,
          providerSessionIdentity: providerSessionId
        },
        deliveries
      )
    },
    sessionMarkdownDraftRead(workspaceId, tabId, relativePath) {
      return loadMobileSessionMarkdownDraft({
        ...draftScope,
        workspaceIdentity: workspaceId,
        tabIdentity: tabId,
        relativePath
      })
    },
    sessionMarkdownDraftWrite(workspaceId, tabId, relativePath, draft) {
      return saveMobileSessionMarkdownDraft(
        {
          ...draftScope,
          workspaceIdentity: workspaceId,
          tabIdentity: tabId,
          relativePath
        },
        draft
      )
    }
  }
}

export const MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY = createMobileWebNativeCapabilityAuthority({
  hostIdentity: 'native-mobile',
  buildIdentity: 'native-mobile-v1'
})
