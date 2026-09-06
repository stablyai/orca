import type { RoomAgentActivity, RoomEvent } from '../../../shared/rooms'

export type RoomListener = (event: RoomEvent) => void

export class RoomEventBus {
  private readonly listeners = new Map<string, Set<RoomListener>>()
  private readonly activities = new Map<string, Map<string, RoomAgentActivity>>()

  constructor(private readonly broadcast?: (roomId: string, event: RoomEvent) => void) {}

  subscribe(roomId: string, initial: RoomEvent, listener: RoomListener): () => void {
    const roomListeners = this.listeners.get(roomId) ?? new Set<RoomListener>()
    roomListeners.add(listener)
    this.listeners.set(roomId, roomListeners)
    listener(initial)
    for (const activity of this.activities.get(roomId)?.values() ?? []) {
      listener({ type: 'activity.updated', activity })
    }
    return () => {
      roomListeners.delete(listener)
      if (roomListeners.size === 0) {
        this.listeners.delete(roomId)
      }
    }
  }

  emit(roomId: string, event: RoomEvent): void {
    if (event.type === 'activity.updated') {
      const activities = this.activities.get(roomId) ?? new Map<string, RoomAgentActivity>()
      activities.set(event.activity.participantId, event.activity)
      this.activities.set(roomId, activities)
    } else if (event.type === 'activity.cleared') {
      this.removeActivity(roomId, event.participantId)
    } else if (event.type === 'message.created' && event.message.actorKind === 'agent') {
      this.removeActivity(roomId, event.message.senderId)
    } else if (event.type === 'participant.removed') {
      this.removeActivity(roomId, event.participantId)
    }
    this.broadcast?.(roomId, event)
    for (const listener of this.listeners.get(roomId) ?? []) {
      try {
        listener(event)
      } catch {
        // Renderer failures cannot interrupt room persistence or delivery.
      }
    }
  }

  clear(): void {
    this.listeners.clear()
    this.activities.clear()
  }

  endRoom(roomId: string): void {
    const event: RoomEvent = { type: 'end', reason: 'deleted' }
    this.broadcast?.(roomId, event)
    for (const listener of this.listeners.get(roomId) ?? []) {
      try {
        listener(event)
      } catch {}
    }
    this.listeners.delete(roomId)
    this.activities.delete(roomId)
  }

  private removeActivity(roomId: string, participantId: string | null): void {
    if (!participantId) {
      return
    }
    const activities = this.activities.get(roomId)
    activities?.delete(participantId)
    if (activities?.size === 0) {
      this.activities.delete(roomId)
    }
  }
}
