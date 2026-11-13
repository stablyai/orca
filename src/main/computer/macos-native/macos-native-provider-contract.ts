import type net from 'node:net'
import type { ComputerProviderCapabilities } from '../../../shared/computer-use-runtime-types'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionStatus
} from '../../../shared/computer-use-permissions-types'

export type NativePermissionStatus = Partial<
  Record<ComputerUsePermissionId, ComputerUsePermissionStatus>
>

function readNativePermissionValue(value: unknown): ComputerUsePermissionStatus | undefined {
  return value === 'granted' || value === 'not-granted' || value === 'unsupported'
    ? value
    : undefined
}

/**
 * Reads the helper's permissionStatus reply. Unrecognized values are dropped,
 * which callers report as not-granted, so a malformed reply never reads as a grant.
 */
export function parseNativePermissionStatus(value: unknown): NativePermissionStatus {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const accessibility =
    'accessibility' in value ? readNativePermissionValue(value.accessibility) : undefined
  const screenshots =
    'screenshots' in value ? readNativePermissionValue(value.screenshots) : undefined
  return {
    ...(accessibility ? { accessibility } : {}),
    ...(screenshots ? { screenshots } : {})
  }
}

export type NativeMethod =
  | 'handshake'
  | 'permissionStatus'
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
  'handshake' | 'permissionStatus' | 'listApps' | 'listWindows' | 'getAppState' | 'terminate'
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

export function macOSActionCapabilityKey(
  method: NativeActionMethod
): keyof ComputerProviderCapabilities['supports']['actions'] {
  const keys = {
    click: 'click',
    performSecondaryAction: 'performAction',
    scroll: 'scroll',
    drag: 'drag',
    typeText: 'typeText',
    pressKey: 'pressKey',
    hotkey: 'hotkey',
    pasteText: 'pasteText',
    setValue: 'setValue'
  } satisfies Record<NativeActionMethod, keyof ComputerProviderCapabilities['supports']['actions']>
  return keys[method]
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
