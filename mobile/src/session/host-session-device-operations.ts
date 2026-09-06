import type {
  MobileWebClipboardAvailability,
  MobileWebClipboardWriteResult,
  MobileWebHapticKind,
  MobileWebTerminalAccessoryPreferences,
  MobileWebTerminalCustomKey,
  MobileWebTerminalPreferences,
  MobileWebTerminalTextScale
} from '../../../src/shared/mobile-web/native-operation-contract'

export type HostSessionDeviceOperations = {
  hapticFeedback: (kind: MobileWebHapticKind) => void
  clipboardAvailability: () => Promise<MobileWebClipboardAvailability>
  copyText: (text: string) => Promise<MobileWebClipboardWriteResult>
  openExternalUrl: (url: string) => Promise<void>
  openTerminalSettings: () => void
  loadTerminalPreferences: () => Promise<MobileWebTerminalPreferences>
  loadTerminalAccessoryPreferences: () => Promise<MobileWebTerminalAccessoryPreferences>
  saveTerminalCustomKeys: (customKeys: readonly MobileWebTerminalCustomKey[]) => Promise<void>
  saveTerminalTextScale: (textScale: MobileWebTerminalTextScale) => Promise<void>
}
