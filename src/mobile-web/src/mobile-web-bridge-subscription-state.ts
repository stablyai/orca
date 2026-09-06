import type { z } from 'zod'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

export type MobileWebPendingSubscription = {
  subscriptionId: string
  resolve: () => void
  reject: (error: MobileWebBridgeClientError) => void
  timer: ReturnType<typeof setTimeout>
}

export type MobileWebActiveSubscription = {
  requestId: string
  nextSequence: number
  eventSchema: z.ZodType<unknown>
  onEvent: (value: unknown) => void
  onError: (error: MobileWebBridgeClientError) => void
}
