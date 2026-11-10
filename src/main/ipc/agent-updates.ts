import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { AgentUpdateRequestSchema } from '../../shared/agent-updates/agent-update-types'
import type { AgentUpdatesState } from '../../shared/agent-updates/agent-update-types'
import {
  getAgentUpdatesState,
  onAgentUpdatesChanged,
  refreshAgentUpdates,
  startAgentUpdates
} from '../agent-updates/agent-update-service'
import type { AgentUpdateSettings } from '../agent-updates/check-agent-updates'
import type { Store } from '../persistence/loading-store/store'
import { isTrustedUIRenderer, sendToTrustedUIRenderer } from './ui'

// Why: these channels run update commands, so only the trusted app UI may call them.
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized agent update IPC sender')
  }
}

export function registerAgentUpdatesHandlers(store: Pick<Store, 'getSettings'>): void {
  const readSettings = (): AgentUpdateSettings => {
    const { disabledTuiAgents, agentCmdOverrides } = store.getSettings()
    return { disabledTuiAgents, agentCmdOverrides }
  }

  onAgentUpdatesChanged((state) => sendToTrustedUIRenderer('agentUpdates:state', state))

  ipcMain.handle('agentUpdates:getState', (event): AgentUpdatesState => {
    assertTrustedSender(event)
    return getAgentUpdatesState()
  })

  ipcMain.handle('agentUpdates:refresh', (event): Promise<AgentUpdatesState> => {
    assertTrustedSender(event)
    return refreshAgentUpdates(readSettings())
  })

  ipcMain.handle('agentUpdates:update', (event, value: unknown): Promise<void> => {
    assertTrustedSender(event)
    const request = AgentUpdateRequestSchema.parse(value)
    return startAgentUpdates(request.agents, readSettings())
  })
}
