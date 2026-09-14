import {
  NativeModule,
  requireOptionalNativeModule,
  type EventSubscription
} from 'expo-modules-core'

export type HardwareKeyboardNativeCommand = {
  actionId: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

export type HardwareKeyboardCommandEvent = {
  actionId: string
  key: string
}

type HardwareKeyboardNavigationEvents = {
  onHardwareKeyboardCommand(event: HardwareKeyboardCommandEvent): void
}

declare class HardwareKeyboardNavigationNativeModule extends NativeModule<HardwareKeyboardNavigationEvents> {
  setCommands(commands: HardwareKeyboardNativeCommand[]): void
  isHardwareKeyboardConnected(): boolean
}

const nativeModule = requireOptionalNativeModule<HardwareKeyboardNavigationNativeModule>(
  'ExpoHardwareKeyboardNavigation'
)

export function setHardwareKeyboardCommands(commands: HardwareKeyboardNativeCommand[]): void {
  nativeModule?.setCommands(commands)
}

export function isHardwareKeyboardConnected(): boolean {
  return nativeModule?.isHardwareKeyboardConnected() ?? false
}

export function addHardwareKeyboardCommandListener(
  listener: (event: HardwareKeyboardCommandEvent) => void
): EventSubscription | null {
  return nativeModule?.addListener('onHardwareKeyboardCommand', listener) ?? null
}
