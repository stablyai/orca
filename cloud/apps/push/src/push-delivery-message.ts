import { createHash } from 'node:crypto'
import { type PushNotification } from '@orca-cloud/push-contract'

export type PushOrcaData = {
  kind?: 'alert' | 'dismiss'
  hostFingerprint: string
  worktreeId?: string
  paneKey?: string
  notificationId?: string
  notificationSeq: number
  notificationEpoch: string
  source: string
  agentState: string | null
}

export type PushDelivery = {
  expiresAt: number
  sound?: boolean
  registrationId: string
  hostFingerprint: string
  title: string
  body: string
  collapseId: string
  orca: PushOrcaData
}

export function collapseIdFor(notification: PushNotification, hostFingerprint: string): string {
  const identity =
    notification.notificationId === undefined
      ? [notification.notificationEpoch, notification.notificationSeq]
      : notification.notificationId
  return createHash('sha256')
    .update(JSON.stringify([hostFingerprint, identity]))
    .digest('hex')
}

export function buildPushDelivery(input: {
  expiresAt: number
  registrationId: string
  hostFingerprint: string
  notification: PushNotification
}): PushDelivery {
  const { notification, hostFingerprint } = input
  return {
    ...(notification.sound === false ? { sound: false } : {}),
    expiresAt: input.expiresAt,
    registrationId: input.registrationId,
    hostFingerprint,
    title: notification.title,
    body: notification.body,
    collapseId: collapseIdFor(notification, hostFingerprint),
    orca: {
      ...(notification.kind ? { kind: notification.kind } : {}),
      hostFingerprint,
      ...(notification.paneKey === undefined ? {} : { paneKey: notification.paneKey }),
      ...(notification.worktreeId === undefined ? {} : { worktreeId: notification.worktreeId }),
      ...(notification.notificationId === undefined
        ? {}
        : { notificationId: notification.notificationId }),
      notificationSeq: notification.notificationSeq,
      notificationEpoch: notification.notificationEpoch,
      source: notification.source,
      agentState: notification.agentState
    }
  }
}

export function orcaDataStrings(orca: PushOrcaData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(orca)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      ])
  )
}
