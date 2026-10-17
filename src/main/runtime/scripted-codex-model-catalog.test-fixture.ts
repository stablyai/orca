import { onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

/** Independent discovery for the scripted runtime; the live chat never handles model/list. */
export function installScriptedCodexModelCatalog(sessionId: string, cwd: string) {
  const host = getStructuredAgentSessionHost()!
  const probe = vi.fn(async () => ({
    origin: 'probe' as const,
    complete: true,
    models: [
      {
        id: 'gpt-live',
        label: 'GPT Live',
        isDefault: true,
        efforts: [{ value: 'medium', label: 'Medium' }],
        serviceTiers: [{ value: 'fast', label: 'Fast' }]
      }
    ]
  }))
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: (id) => host.deps.store.getRecord(id) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => host.deps.store.getRecord(sessionId)!.accountHome,
    recordWorkspacePath: async () => cwd,
    probes: { codex: probe }
  })
  host.deps.modelCatalog = catalog
  onTestFinished(() => catalog.stop())
  return { probe }
}
