import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const agentHookConsentApi = {
  offer: (agent) => ipcRenderer.invoke('agent-hook-consent:offer', agent),
  decide: (args) => ipcRenderer.invoke('agent-hook-consent:decide', args),
  statuses: () => ipcRenderer.invoke('agent-hook-consent:statuses')
} satisfies PreloadApi['agentHookConsent']
