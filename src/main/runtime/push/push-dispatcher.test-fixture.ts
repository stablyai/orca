import { vi } from 'vitest'
import type { MobilePushRegistration } from '../../../shared/mobile-push-contract'
import type { MobileNotificationEvent } from '../runtime-mobile-notification-controller'
import type { PushGatewayClient, PushSendResult } from './push-gateway-client'
import { PushDispatcher, type PushDispatcherRegistry } from './push-dispatcher'

export function registration(
  overrides: Partial<MobilePushRegistration> = {}
): MobilePushRegistration {
  return {
    registrationId: 'reg-1',
    filter: {},
    expiresAt: Date.now() + 7 * 86400_000,
    ...overrides
  }
}

export type SendCall = Parameters<PushGatewayClient['send']>[0]

export function createHarness(options: {
  devices: { deviceId: string; pushRegistration?: MobilePushRegistration }[]
  results?: PushSendResult[]
  sendImpl?: () => Promise<never>
}): {
  dispatcher: PushDispatcher
  sends: SendCall[]
  cleared: (string | null)[]
  runRetry: () => void
} {
  const sends: SendCall[] = []
  const cleared: (string | null)[] = []
  let retry: (() => void) | null = null
  const client = {
    send: vi.fn(async (input: SendCall) => {
      sends.push(input)
      if (options.sendImpl) {
        return await options.sendImpl()
      }
      return {
        ok: true as const,
        results:
          options.results ??
          input.registrationIds.map((registrationId) => ({
            registrationId,
            status: 'queued' as const
          }))
      }
    })
  } as unknown as PushGatewayClient
  const registry: PushDispatcherRegistry = {
    listDevices: () => options.devices,
    setPushRegistration: (deviceId, value) => {
      cleared.push(value === null ? deviceId : null)
      return true
    }
  }
  return {
    dispatcher: new PushDispatcher({
      client,
      registry,
      scheduleRetry: (run) => {
        retry = run
      }
    }),
    sends,
    cleared,
    runRetry: () => retry?.()
  }
}

export function notification(
  overrides: Partial<MobileNotificationEvent> = {}
): MobileNotificationEvent {
  return {
    type: 'notification',
    source: 'agent-task-complete',
    title: 'feat/x - Claude finished',
    body: 'All done.',
    worktreeId: 'repo::wt1',
    notificationId: 'agent:one',
    notificationSeq: 7,
    notificationEpoch: 'epoch-1',
    agentState: 'done',
    ...overrides
  } as MobileNotificationEvent
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
