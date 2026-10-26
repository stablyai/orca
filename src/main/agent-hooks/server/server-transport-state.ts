import type { Server } from 'node:http'
import type { JcodeSpawnListener } from './server-jcode-spawn'

export abstract class AgentHookServerTransportState {
  protected server: Server | null = null
  protected port = 0
  protected token = ''
  protected endpointFileWritten = false
  protected onJcodeSpawn: JcodeSpawnListener | null = null
  protected readonly jcodeSpawns = new Set<AbortController>()

  protected abortJcodeSpawns(): void {
    for (const controller of this.jcodeSpawns) {
      controller.abort('stopped')
    }
  }

  protected rollbackTransportStart(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
  }
}
