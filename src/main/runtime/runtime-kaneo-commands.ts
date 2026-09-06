import { connectKaneo, getKaneoTask } from '../kaneo/client'
import { disconnectKaneo, getKaneoStatus } from '../kaneo/credential-store'
import type { KaneoConnectArgs } from '../../shared/kaneo-types'

export class RuntimeKaneoCommands {
  kaneoStatus() {
    return getKaneoStatus()
  }
  kaneoConnect(args: KaneoConnectArgs) {
    return connectKaneo(args)
  }
  kaneoDisconnect() {
    disconnectKaneo()
    return { ok: true }
  }
  kaneoGetTask(url: string, signal?: AbortSignal) {
    return getKaneoTask(url, signal)
  }
}
