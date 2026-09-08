import { executeDiagnosticsDeviceOperation } from './mobile-web-diagnostics-device-operations'
import { executeSettingsDeviceOperation } from './mobile-web-settings-device-operations'
import {
  MobileWebPagePreferencesPayloadSchema,
  MobileWebPagePreferencesResultSchema
} from '../../../src/shared/mobile-web/page-preferences-contract'
import {
  MobileWebClipboardAvailabilityPayloadSchema,
  MobileWebClipboardAvailabilityResultSchema,
  MobileWebClipboardWritePayloadSchema,
  MobileWebClipboardWriteResultSchema,
  MobileWebHapticFeedbackPayloadSchema,
  MobileWebHapticSelectionPayloadSchema,
  MobileWebNativeAlertPayloadSchema,
  MobileWebNativeAlertResultSchema,
  MobileWebOpenExternalPayloadSchema,
  MobileWebSessionChatDraftReadPayloadSchema,
  MobileWebSessionChatDraftReadResultSchema,
  MobileWebSessionChatDraftWritePayloadSchema,
  MobileWebTerminalAccessoryPreferencesPayloadSchema,
  MobileWebTerminalAccessoryPreferencesResultSchema,
  MobileWebTerminalCustomKeysUpdatePayloadSchema,
  MobileWebTerminalPreferencesPayloadSchema,
  MobileWebTerminalPreferencesResultSchema,
  MobileWebTerminalTextScaleUpdatePayloadSchema
} from '../../../src/shared/mobile-web/native-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebNativeCapabilityOperation(args: {
  operation: string
  payload: unknown
  authority: MobileWebNativeCapabilityAuthority
  workspaceAuthority?: MobileWebWorkspaceAuthority
}): Promise<unknown> {
  if (['diagnosticsSnapshot', 'diagnosticsProbe', 'diagnosticsSubmit'].includes(args.operation)) {
    return executeDiagnosticsDeviceOperation(
      args.operation,
      args.payload,
      args.authority.diagnosticsDevice
    )
  }
  if (
    ['notificationPermission', 'notificationPreference', 'openSystemSettings'].includes(
      args.operation
    )
  ) {
    return executeSettingsDeviceOperation(
      args.operation,
      args.payload,
      args.authority.settingsDevice
    )
  }
  if (args.operation === 'pagePreferences') {
    const payload = MobileWebPagePreferencesPayloadSchema.parse(args.payload)
    if (!args.authority.pagePreferences) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    return MobileWebPagePreferencesResultSchema.parse(await args.authority.pagePreferences(payload))
  }
  if (args.operation === 'alert') {
    const payload = MobileWebNativeAlertPayloadSchema.parse(args.payload)
    if (!args.authority.alert) {
      throw new MobileWebBrokerError('unavailable')
    }
    return MobileWebNativeAlertResultSchema.parse(await args.authority.alert(payload))
  }
  if (args.operation === 'hapticSelection') {
    MobileWebHapticSelectionPayloadSchema.parse(args.payload)
    args.authority.hapticFeedback('selection')
    return null
  }
  if (args.operation === 'hapticFeedback') {
    const payload = MobileWebHapticFeedbackPayloadSchema.parse(args.payload)
    args.authority.hapticFeedback(payload.kind)
    return null
  }
  if (args.operation === 'terminalPreferences') {
    MobileWebTerminalPreferencesPayloadSchema.parse(args.payload)
    return MobileWebTerminalPreferencesResultSchema.parse(
      await args.authority.terminalPreferences()
    )
  }
  if (args.operation === 'terminalAccessoryPreferences') {
    MobileWebTerminalAccessoryPreferencesPayloadSchema.parse(args.payload)
    if (!args.authority.terminalAccessoryPreferences) {
      throw new MobileWebBrokerError('unavailable')
    }
    return MobileWebTerminalAccessoryPreferencesResultSchema.parse(
      await args.authority.terminalAccessoryPreferences()
    )
  }
  if (args.operation === 'clipboardAvailability') {
    MobileWebClipboardAvailabilityPayloadSchema.parse(args.payload)
    return MobileWebClipboardAvailabilityResultSchema.parse(
      await args.authority.clipboardAvailability()
    )
  }
  if (args.operation === 'sessionChatDraftRead') {
    const payload = MobileWebSessionChatDraftReadPayloadSchema.parse(args.payload)
    if (!args.authority.sessionChatDraftRead || !args.workspaceAuthority) {
      throw new MobileWebBrokerError('unavailable')
    }
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    return MobileWebSessionChatDraftReadResultSchema.parse({
      text: await args.authority.sessionChatDraftRead(hostWorkspaceId, payload.tabId)
    })
  }
  if (args.operation === 'sessionChatDraftWrite') {
    const payload = MobileWebSessionChatDraftWritePayloadSchema.parse(args.payload)
    if (!args.authority.sessionChatDraftWrite || !args.workspaceAuthority) {
      throw new MobileWebBrokerError('unavailable')
    }
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    await args.authority.sessionChatDraftWrite(hostWorkspaceId, payload.tabId, payload.text)
    return null
  }
  if (args.operation === 'clipboardWrite') {
    const payload = MobileWebClipboardWritePayloadSchema.parse(args.payload)
    return MobileWebClipboardWriteResultSchema.parse(
      await args.authority.clipboardWrite(payload.text)
    )
  }
  if (args.operation === 'openExternal') {
    const payload = MobileWebOpenExternalPayloadSchema.parse(args.payload)
    await args.authority.openExternal(payload.url)
    return null
  }
  if (args.operation === 'terminalTextScaleUpdate') {
    const payload = MobileWebTerminalTextScaleUpdatePayloadSchema.parse(args.payload)
    await args.authority.terminalTextScaleUpdate(payload.textScale)
    return null
  }
  if (args.operation === 'terminalCustomKeysUpdate') {
    const payload = MobileWebTerminalCustomKeysUpdatePayloadSchema.parse(args.payload)
    if (!args.authority.terminalCustomKeysUpdate) {
      throw new MobileWebBrokerError('unavailable')
    }
    await args.authority.terminalCustomKeysUpdate(payload.customKeys)
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
