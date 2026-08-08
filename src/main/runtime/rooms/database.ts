import SyncDatabase from '../../sqlite/sync-database'
import type { RoomSnapshot } from '../../../shared/rooms'
import { initializeRoomSchema } from './schema'
import { RoomCoreStore } from './core-store'
import { RoomMessageStore } from './messages'
import { RoomPinStore } from './pins'
import { RoomParticipantStore } from './participants'
import { RoomProviderMessageStore } from './provider-messages'
import { RoomActivityStore } from './activities'
import { RoomDeliveryConfigurationStore } from './delivery-configuration'

export class RoomDatabase {
  private readonly db: SyncDatabase.Database
  readonly core: RoomCoreStore
  readonly participants: RoomParticipantStore
  readonly messages: RoomMessageStore
  readonly pins: RoomPinStore
  readonly providerMessages: RoomProviderMessageStore
  readonly activities: RoomActivityStore
  readonly deliveryConfiguration: RoomDeliveryConfigurationStore

  constructor(path: string) {
    this.db = new SyncDatabase(path)
    initializeRoomSchema(this.db)
    this.core = new RoomCoreStore(this.db)
    this.participants = new RoomParticipantStore(this.db)
    this.messages = new RoomMessageStore(this.db)
    this.pins = new RoomPinStore(this.db)
    this.providerMessages = new RoomProviderMessageStore(this.db, this.messages)
    this.activities = new RoomActivityStore(this.db)
    this.deliveryConfiguration = new RoomDeliveryConfigurationStore(this.db)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createRoom(input: Parameters<RoomCoreStore['create']>[0]): RoomSnapshot {
    const room = this.core.create(input)
    return this.snapshot(room.id, input.userIdentity?.trim() || 'user')
  }

  snapshot(roomId: string, readerKey = 'user'): RoomSnapshot {
    return {
      room: this.core.get(roomId),
      participants: this.participants.list(roomId),
      activities: this.activities.list(roomId),
      roles: this.core.listRoles(roomId),
      pins: this.pins.list(roomId),
      unread: this.messages.getUnread(roomId, readerKey)
    }
  }
}
