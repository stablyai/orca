import { nativeChatFollowUpBehaviorRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { NativeChatFollowUpBehavior } from '../../../src/shared/native-chat-follow-up-behavior'

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
  private value: NativeChatFollowUpBehavior = 'steer'
  private readonly listeners = new Set<() => void>()
  private stopState?: () => void
  private stopStream?: () => void
  private generation = 0
  private readVersion = 0
  private connectionVersion = 0

  constructor(private readonly client: RpcClient) {}

  getSnapshot = (): boolean =>
    this.generation === (this.client.getGeneration?.() ?? 0) && this.value === 'queue'

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

  private publish(value: NativeChatFollowUpBehavior): void {
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
    if (generation !== this.generation) {
      this.generation = generation
      this.publish('steer')
    }
    if (this.client.getState() !== 'connected') {
      return
    }
    const current = (): boolean =>
      connectionVersion === this.connectionVersion &&
      generation === (this.client.getGeneration?.() ?? 0)
    const read = (): void => {
      const version = ++this.readVersion
      void nativeChatFollowUpBehaviorRead
        .request(this.client)
        .then((response) => {
          const preference = nativeChatFollowUpBehaviorRead.interpret(response)
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
      const event: { type?: unknown; behavior?: unknown; snapshot?: unknown } = payload
      let behavior: unknown
      if (event.type === 'nativeChatFollowUpBehaviorChanged') {
        behavior = event.behavior
      } else if (event.type === 'ready') {
        const snapshot = event.snapshot
        if (snapshot && typeof snapshot === 'object' && 'nativeChatFollowUpBehavior' in snapshot) {
          behavior = snapshot.nativeChatFollowUpBehavior
        } else {
          read()
          return
        }
      } else {
        return
      }
      if (behavior === 'queue' || behavior === 'steer') {
        this.readVersion += 1
        this.publish(behavior)
      }
    })
  }
}
