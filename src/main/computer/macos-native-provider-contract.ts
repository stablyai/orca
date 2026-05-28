import type net from 'net'
import type { ComputerProviderCapabilities } from '../../shared/runtime-types'

export type NativeMethod =
  | 'handshake'
  | 'listApps'
  | 'listWindows'
  | 'getAppState'
  | 'click'
  | 'performSecondaryAction'
  | 'scroll'
  | 'drag'
  | 'typeText'
  | 'pressKey'
  | 'hotkey'
  | 'pasteText'
  | 'setValue'
  | 'terminate'

export type NativeActionMethod = Exclude<
  NativeMethod,
  'handshake' | 'listApps' | 'listWindows' | 'getAppState' | 'terminate'
>

export type NativeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

export type PendingNativeRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export const REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION = 1

export function assertMacOSProviderCapability(
  capabilities: ComputerProviderCapabilities | null,
  group: keyof ComputerProviderCapabilities['supports'],
  capability: string
): boolean {
  const groupCapabilities = capabilities?.supports[group] as Record<string, boolean> | undefined
  return groupCapabilities?.[capability] === true
}

export function writeNativeProviderLine(transport: net.Socket, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transport.write(line, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
