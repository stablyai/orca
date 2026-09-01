// Local preload IPC for agent-catalog authoring: revision-checked mutations,
// env-value-free local summaries, the bounded single-row draft read, and the
// desktop-only reference summary. None of these are runtime RPC methods — the
// remote surface receives only the env-free revisioned snapshot.

import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { CustomTuiAgentId } from '../../shared/types'
import type { AgentCatalogMutationRequest } from '../../shared/agent-catalog-snapshot'
import type { AgentReferenceMutationRequest } from '../../shared/agent-reference-snapshot'
import { isCustomTuiAgentId } from '../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import { getOrCreateAgentCatalogService } from '../agent-launch/agent-catalog-service'
import { applyAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { haveSameDisabledTuiAgents } from '../../shared/tui-agent-selection'

/** Managed status hooks must be installed/removed to match the disabled set. The
 *  catalog API is the only writer of `disabledTuiAgents` from the desktop client
 *  (the generic settings write strips it), so the reconcile rides here. */
async function reconcileManagedHooksForDisabledAgents(store: Store): Promise<void> {
  const settings = store.getSettings()
  try {
    await applyAgentStatusHooksEnabled(settings.agentStatusHooksEnabled, settings, {
      shouldHydrateShellPath: app.isPackaged,
      onInstallError: recordManagedHookInstallFailure,
      shouldContinue: (agent) => {
        const current = store.getSettings()
        return (
          current.agentStatusHooksEnabled !== false && !current.disabledTuiAgents.includes(agent)
        )
      }
    })
  } catch (error) {
    console.warn('[agent-catalog] failed to reconcile managed agent hooks:', error)
  }
}

export function registerAgentCatalogHandlers(store: Store): void {
  const service = getOrCreateAgentCatalogService(store)

  ipcMain.handle('settings:agentCatalog:getLocal', () => {
    return service.getLocalSnapshot()
  })

  ipcMain.handle(
    'settings:mutateAgentCatalog',
    async (_event, request: AgentCatalogMutationRequest) => {
      if (
        !request ||
        typeof request !== 'object' ||
        typeof request.expectedRevision !== 'number' ||
        !request.mutation ||
        typeof request.mutation !== 'object'
      ) {
        return { ok: false, code: 'invalid_agent_field', revision: service.getRevision() }
      }
      const disabledBefore = store.getSettings().disabledTuiAgents
      const result = service.mutate(request)
      // Enable/disable is one of several mutation kinds, and a delete can drop an
      // id out of the set too, so the committed set decides — not the request.
      if (
        'ok' in result &&
        result.ok &&
        !haveSameDisabledTuiAgents(disabledBefore, store.getSettings().disabledTuiAgents)
      ) {
        await reconcileManagedHooksForDisabledAgents(store)
      }
      return result
    }
  )

  ipcMain.handle(
    'settings:agentCatalog:getLocalDraft',
    (
      _event,
      args: { locator: { id?: unknown; repairToken?: unknown }; expectedRevision?: unknown }
    ) => {
      const expectedRevision =
        typeof args?.expectedRevision === 'number' ? args.expectedRevision : -1
      const locator = args?.locator
      if (locator && isCustomTuiAgentId(locator.id)) {
        return service.getLocalDraft({ id: locator.id }, expectedRevision)
      }
      if (locator && typeof locator.repairToken === 'string') {
        return service.getLocalDraft({ repairToken: locator.repairToken }, expectedRevision)
      }
      return { status: 'stale' }
    }
  )

  ipcMain.handle('settings:agentCatalog:referenceSummary', (_event, args: { id?: unknown }) => {
    if (!args || !isCustomTuiAgentId(args.id)) {
      return []
    }
    return service.getReferenceSummaries(args.id as CustomTuiAgentId)
  })

  ipcMain.handle('settings:agentCatalog:baseDisableImpact', (_event, args: { base?: unknown }) => {
    // Only a built-in base can be disabled-as-base; anything else has no impact.
    if (!args || !isBuiltInTuiAgent(args.base)) {
      return {
        savedReferences: { count: 0, atLeast: false },
        resumableSessions: { count: 0, atLeast: false }
      }
    }
    return service.getBaseDisableImpact(args.base)
  })

  ipcMain.handle('settings:agentReferences:getLocal', () => {
    return service.getLocalReferenceSnapshot()
  })

  ipcMain.handle(
    'settings:mutateAgentReferences',
    (_event, request: AgentReferenceMutationRequest) => {
      if (
        !request ||
        typeof request !== 'object' ||
        typeof request.expectedReferenceRevision !== 'number' ||
        !request.mutation ||
        typeof request.mutation !== 'object'
      ) {
        return {
          ok: false,
          code: 'invalid_reference_field',
          referenceRevision: service.getReferenceRevision(),
          catalogRevision: service.getRevision()
        }
      }
      return service.mutateReferences(request)
    }
  )
}
