import { nativeChatQueueFollowUpsRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { nativeChatQueueFollowUps } from '../../../src/shared/native-chat-follow-up-behavior'

const projections = new WeakMap<RpcClient, MobileNativeChatFollowUpPreference>()

/** The connection owns one live host preference shared by every mounted chat. */
export function mobileNativeChatFollowUpPreference(
  client: RpcClient
): MobileNativeChatFollowUpPreference {
  let projection = projections.get(client)
  if (!projection) {
    projection = new MobileNativeChatFollowUpPreference(client)
    projections.set(client, projection)
  }
  return projection
}

class MobileNativeChatFollowUpPreference {
  private value = nativeChatQueueFollowUps(null)
  private readonly listeners = new Set<() => void>()
  private stopState?: () => void
  private stopStream?: () => void
  private readVersion = 0
  private connectionVersion = 0

  constructor(private readonly client: RpcClient) {}

  getSnapshot = (): boolean => this.value

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

  private publish(value: boolean): void {
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
      void nativeChatQueueFollowUpsRead
        .request(this.client)
        .then((response) => {
          const preference = nativeChatQueueFollowUpsRead.interpret(response)
          if (current() && version === this.readVersion && preference.accepted) {
            this.publish(preference.value)
          }
        })
        .catch(() => {
          // Keep this host's last answer until a ready snapshot repairs the gap.
        })
    }
    read()
    this.stopStream = this.client.subscribe('runtime.clientEvents.subscribe', null, (payload) => {
      if (!current() || !payload || typeof payload !== 'object') {
        return
      }
      const event: { type?: unknown; queueFollowUps?: unknown; snapshot?: unknown } = payload
      let queueFollowUps: unknown
      if (event.type === 'nativeChatQueueFollowUpsChanged') {
        queueFollowUps = event.queueFollowUps
      } else if (event.type === 'ready') {
        const snapshot = event.snapshot
        if (snapshot && typeof snapshot === 'object' && 'nativeChatQueueFollowUps' in snapshot) {
          queueFollowUps = snapshot.nativeChatQueueFollowUps
        } else {
          read()
          return
        }
      } else {
        return
      }
      if (typeof queueFollowUps === 'boolean') {
        this.readVersion += 1
        this.publish(queueFollowUps)
      }
    })
  }
}
