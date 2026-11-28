import { ipcMain } from 'electron'
import { isAgentHookTarget } from '../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import type {
  ConsentServiceStore,
  createAgentHookConsentService
} from './agent-hook-consent-service'

type ConsentService = ReturnType<typeof createAgentHookConsentService>

/** Registers the card's IPC; the installers load on the first call, not at boot (#51052). */
export function registerAgentHookConsentIpc(
  store: ConsentServiceStore,
  options: { shouldHydrateShellPath: boolean }
): void {
  let service: Promise<ConsentService> | null = null
  const load = (): Promise<ConsentService> =>
    (service ??= import('./agent-hook-consent-service').then((module) =>
      module.createAgentHookConsentService(store, options)
    ))
  ipcMain.handle('agent-hook-consent:offer', async (_event, agent: unknown) =>
    (await load()).resolveOffer(typeof agent === 'string' ? agent : '')
  )
  ipcMain.handle(
    'agent-hook-consent:decide',
    async (_event, args: { agents?: unknown; decision?: unknown }) => {
      const agents = Array.isArray(args?.agents) ? args.agents.filter(isAgentHookTarget) : []
      const decision = args?.decision
      if (agents.length === 0 || (decision !== 'granted' && decision !== 'declined')) {
        return []
      }
      return (await load()).decide(agents, decision)
    }
  )
  ipcMain.handle('agent-hook-consent:statuses', async () => (await load()).statuses())
}
