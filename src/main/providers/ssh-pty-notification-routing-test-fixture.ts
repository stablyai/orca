import { vi, type Mock } from 'vitest'
import {
  subscribeSshPtyNotifications,
  type SshPtyNotificationSubscription
} from './ssh-pty-notification-routing'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'

type NotificationHandler = (method: string, params: Record<string, unknown>) => void
type CancellationRequest = (
  method: string,
  params: Record<string, unknown>
) => Promise<{ canceled: boolean; sentEndSu: number; creditedEndSu: number }>

type MockMux = {
  onNotification: Mock<(handler: NotificationHandler) => void>
  request: Mock<CancellationRequest>
}

export type SshPtyNotificationTestSubscription = {
  handler: NotificationHandler
  mux: MockMux
  toAppPtyId: Mock<(id: string) => string>
  dataListeners: Set<(payload: { id: string; data: string }) => void>
  replayListeners: Set<(payload: { id: string; data: string }) => void>
  exitListeners: Set<(payload: { id: string; code: number }) => void>
  livePtyIds: Set<string>
  recordExit: Mock<(relayPtyId: string, incarnationId: unknown) => void>
  resolvePtyIncarnation: Mock<(id: string) => string>
  installReceivingActivation: SshPtyNotificationSubscription['installReceivingActivation']
}

export function createSubscription(
  onOwnershipTransferOutput?: (payload: { data: string; source?: unknown }) => void
): SshPtyNotificationTestSubscription {
  const mux: MockMux = {
    onNotification: vi.fn<(handler: NotificationHandler) => void>(),
    request: vi.fn<CancellationRequest>(async () => ({
      canceled: true,
      sentEndSu: 0,
      creditedEndSu: 0
    }))
  }
  const dataListeners = new Set<(payload: { id: string; data: string }) => void>()
  const replayListeners = new Set<(payload: { id: string; data: string }) => void>()
  const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
  const livePtyIds = new Set<string>()
  const recordExit = vi.fn<(relayPtyId: string, incarnationId: unknown) => void>()
  const toAppPtyId = vi.fn((id: string) => `ssh:conn@@${id}`)
  const resolvePtyIncarnation = vi.fn((id: string) => `incarnation:${id}`)

  const subscription = subscribeSshPtyNotifications({
    mux: mux as never,
    toAppPtyId,
    dataListeners: dataListeners as never,
    replayListeners: replayListeners as never,
    exitListeners: exitListeners as never,
    livePtyIds,
    recordExit,
    providerGeneration: 7,
    resolvePtyIncarnation,
    peekPtyIncarnation: () => undefined,
    ...(onOwnershipTransferOutput ? { onOwnershipTransferOutput } : {})
  })

  const handler = mux.onNotification.mock.calls[0]?.[0]
  if (!handler) {
    throw new Error('notification handler was not registered')
  }

  return {
    handler,
    mux,
    toAppPtyId,
    dataListeners,
    replayListeners,
    exitListeners,
    livePtyIds,
    recordExit,
    resolvePtyIncarnation,
    installReceivingActivation: subscription.installReceivingActivation
  }
}

export function sourceActivation(
  overrides: Partial<PtySourceReceivingActivation> = {}
): PtySourceReceivingActivation {
  return Object.freeze({
    status: 'pending',
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    checkpointSourceEndSu: 0,
    recoveryEndSu: 0,
    ...overrides
  })
}
