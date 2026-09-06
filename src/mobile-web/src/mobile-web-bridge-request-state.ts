import type { z } from 'zod'
import type { MobileWebBridgeCapability } from '../../shared/mobile-web/bridge-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

export const MOBILE_WEB_BRIDGE_REQUEST_TIMEOUT_MS = 15_000

export type MobileWebBridgePendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: MobileWebBridgeClientError) => void
  resultSchema: z.ZodType<unknown>
  timer: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
}

export type MobileWebBridgeRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

export function mobileWebBridgeOperationKey(
  capability: MobileWebBridgeCapability,
  operation: string
): string {
  return `${capability}.${operation}`
}
