import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { NativeChatQueueStore } from '../native-chat/queue-store'
import { RoomService } from './rooms/service'
import { OrcaRuntimeWithRoomTerminalLifecycle } from './orca-runtime-room-terminal-lifecycle'
import {
  isStructuredMachineAgentEnabled,
  type StructuredMachineAgent
} from '../../shared/structured-agent-provider'

export class OrcaRuntimeWithRooms extends OrcaRuntimeWithRoomTerminalLifecycle {
  protected roomService: RoomService | null = null
  private nativeChatQueueStore: NativeChatQueueStore | null = null

  getNativeChatQueueStore(): NativeChatQueueStore {
    return (this.nativeChatQueueStore ??= new NativeChatQueueStore(
      getAppEnvironment().getPath('userData')
    ))
  }

  getRoomService(): RoomService {
    if (!this.roomService) {
      this.roomService = new RoomService(
        join(getAppEnvironment().getPath('userData'), 'rooms.db'),
        this
      )
    }
    return this.roomService
  }

  roomLiveSteeringEnabled(): boolean {
    const settings = this.store?.getSettings()
    return (
      settings?.experimentalStructuredNativeChat === true &&
      settings.experimentalRoomLiveSteering === true
    )
  }

  structuredAgentStreamingEnabled(agent: StructuredMachineAgent): boolean {
    const settings = this.store?.getSettings()
    return (
      settings?.experimentalStructuredNativeChat === true &&
      isStructuredMachineAgentEnabled(agent, settings.enabledHarnessStreamingAgents)
    )
  }

  setRoomService(service: RoomService): void {
    this.roomService?.close()
    this.roomService = service
  }

  closeRoomService(): void {
    this.roomService?.close()
    this.roomService = null
  }
}
