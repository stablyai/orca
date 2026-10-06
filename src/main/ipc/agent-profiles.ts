// Management shares the same service and mutation queue as launch acquisition.
import { ipcMain } from 'electron'
import type { AgentProfileConnectionService } from '../agent-profiles/connection-service'
import type {
  AgentProfileConnectionInput,
  AgentProfileSaveInput
} from '../../shared/agent-profile-connection'
export function registerAgentProfileHandlers(service: AgentProfileConnectionService): void {
  ipcMain.handle('agentProfiles:preview', (_event, input: AgentProfileConnectionInput) =>
    service.preview(input)
  )
  ipcMain.handle('agentProfiles:save', (_event, input: AgentProfileSaveInput) =>
    service.save(input)
  )
  ipcMain.handle('agentProfiles:unlink', (_event, id: string) => service.unlink(id))
}
