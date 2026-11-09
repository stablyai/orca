import {
  nativeChatCiResultLinesRead,
  nativeChatQueueFollowUpsRead
} from './mobile-native-chat-host-preference-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  subscribeSharedClientEvents,
  type SharedClientEvent
} from '../transport/connection/shared-client-events'
import { nativeChatQueueFollowUps } from '../../../src/shared/native-chat/input/native-chat-follow-up-behavior'

/** A desktop chat setting the host pushes live: its read, its change event and its ready-snapshot field. */
export type MobileNativeChatHostPreferenceKind = {
  read: typeof nativeChatQueueFollowUpsRead | typeof nativeChatCiResultLinesRead
  changed: (event: SharedClientEvent) => unknown
  snapshotKey: 'nativeChatQueueFollowUps' | 'nativeChatCiResultLines'
  /** What the phone uses while this host hasn't reported the value. */
  unreported: boolean
}

export const QUEUE_FOLLOW_UPS_PREFERENCE: MobileNativeChatHostPreferenceKind = {
  read: nativeChatQueueFollowUpsRead,
  changed: (event) =>
    event.type === 'nativeChatQueueFollowUpsChanged' ? event.queueFollowUps : undefined,
  snapshotKey: 'nativeChatQueueFollowUps',
  unreported: nativeChatQueueFollowUps(null)
}

// Hidden until this desktop reports it, so an older desktop shows no CI lines.
export const CI_RESULT_LINES_PREFERENCE: MobileNativeChatHostPreferenceKind = {
  read: nativeChatCiResultLinesRead,
  changed: (event) =>
    event.type === 'nativeChatCiResultLinesChanged' ? event.ciResultLines : undefined,
  snapshotKey: 'nativeChatCiResultLines',
  unreported: false
}

const projections = new WeakMap<
  RpcClient,
  Map<MobileNativeChatHostPreferenceKind, MobileNativeChatHostPreference>
>()

/** The connection owns one live value per host preference, shared by every mounted chat. */
export function mobileNativeChatHostPreference(
  client: RpcClient,
  kind: MobileNativeChatHostPreferenceKind
): MobileNativeChatHostPreference {
  let byKind = projections.get(client)
  if (!byKind) {
    byKind = new Map()
    projections.set(client, byKind)
  }
  let projection = byKind.get(kind)
  if (!projection) {
    projection = new MobileNativeChatHostPreference(client, kind)
    byKind.set(kind, projection)
  }
  return projection
}

class MobileNativeChatHostPreference {
  private value: boolean | null = null
  private readonly listeners = new Set<() => void>()
  private stopState?: () => void
  private stopStream?: () => void
  private readVersion = 0
  private connectionVersion = 0

  constructor(
    private readonly client: RpcClient,
    private readonly kind: MobileNativeChatHostPreferenceKind
  ) {}

  getSnapshot = (): boolean => this.value ?? this.kind.unreported
  getReportedSnapshot = (): boolean | null => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.stopState = this.client.onStateChange(() => this.connect())
      this.connect()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.connectionVersion += 1
        this.readVersion += 1
        this.stopStream?.()
        this.stopStream = undefined
        this.stopState?.()
        this.stopState = undefined
      }
    }
  }

  private publish(value: boolean | null): void {
    if (value !== this.value) {
      this.value = value
      for (const listener of this.listeners) {
        listener()
      }
    }
  }

  private connect(): void {
    const connectionVersion = ++this.connectionVersion
    this.readVersion += 1
    this.stopStream?.()
    this.stopStream = undefined
    const generation = this.client.getGeneration?.() ?? 0
    if (this.client.getState() !== 'connected') {
      return
    }
    const current = (): boolean =>
      connectionVersion === this.connectionVersion &&
      generation === (this.client.getGeneration?.() ?? 0)
    const read = (): void => {
      const version = ++this.readVersion
      void this.kind.read
        .request(this.client)
        .then((response) => {
          const preference = this.kind.read.interpret(response)
          if (current() && version === this.readVersion && preference.accepted) {
            this.publish(preference.value)
          }
        })
        .catch(() => {
          // Keep this host's last answer until a change event, or the next connection's ready, repairs it.
        })
    }
    read()
    this.stopStream = subscribeSharedClientEvents(this.client, (event) => {
      if (!current()) {
        return
      }
      let value: unknown
      if (event.type === 'ready') {
        if ('joined' in event) {
          // The stream was live before this connect's read went out, so that read already covers it.
          return
        }
        const snapshot = event.snapshot
        if (snapshot && typeof snapshot === 'object' && this.kind.snapshotKey in snapshot) {
          value = snapshot[this.kind.snapshotKey]
        } else {
          read()
          return
        }
      } else {
        value = this.kind.changed(event)
      }
      if (typeof value === 'boolean') {
        this.readVersion += 1
        this.publish(value)
      }
    })
  }
}
