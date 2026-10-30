import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import { finishedListingIds } from '../../../shared/structured-agent-session-options'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import { independentAgentModelCatalog } from '../agent-model-catalog/agent-model-catalog-discovery'
import { AGENT_MODEL_CATALOG_PICKER_WAIT_MS } from '../agent-model-catalog/agent-model-catalog-listing-waiters'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  structuredAgentSessionOptionModels,
  type StructuredAgentSessionRestingOptions as RestingOptions
} from './structured-agent-session-option-models'

/** What the asking client takes: whether it reads an answer that names no model. */
export type StructuredAgentSessionOptionsReader = { readsWithoutModel: boolean; deadline?: number }

/** A same-build caller in this process reads as the RPC gate treats one: it takes no model. */
export const IN_PROCESS_OPTIONS_READER: StructuredAgentSessionOptionsReader = {
  readsWithoutModel: true
}

export async function readStructuredAgentSessionOptionsAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'agents' | 'modelCatalog'>,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<RestingOptions> {
  const record = deps.store.getConversation(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const deadline = reader.readsWithoutModel
    ? undefined
    : (reader.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS)
  const rules = deps.agents.definition(record.provider)?.restingOptions ?? null
  const readCatalog = async (
    inSessionWorkspace: boolean
  ): Promise<AgentSessionModelCatalogResult> =>
    (await deps.modelCatalog
      ?.read({
        agent: record.provider,
        sessionId,
        savedOnly: true,
        ...(!reader.readsWithoutModel ? { legacyOptionsDisplay: true as const } : {}),
        ...(inSessionWorkspace
          ? { inSessionWorkspace: true as const }
          : independentAgentModelCatalog(record.provider)
            ? { workspacePath: null }
            : {})
      })
      .catch(() => null)) ?? { origin: 'unknown' }
  if (!reader.readsWithoutModel) {
    await deps.modelCatalog?.read({
      agent: record.provider,
      sessionId,
      deadline,
      inSessionWorkspace: true,
      waitForListing: true,
      legacyOptionsDisplay: true
    })
    await deps.modelCatalog?.prepareSaved?.({
      agent: record.provider,
      sessionId,
      deadline,
      inSessionWorkspace: true,
      legacyOptionsDisplay: true
    })
  }
  const saved = record.options ?? {}
  // The chat's own folder decides its default, as its first frame did.
  const scoped = await readCatalog(true)
  const folderDefault =
    scoped.origin === 'unknown' ? undefined : scoped.models.find((entry) => entry.isDefault)
  // Where the folder names none, a client that needs a model keeps the account default it got before.
  const catalog =
    saved.model === undefined &&
    !folderDefault &&
    scoped.origin !== 'unknown' &&
    !reader.readsWithoutModel
      ? (await deps.modelCatalog?.prepareSaved?.({
          agent: record.provider,
          sessionId,
          deadline,
          legacyOptionsDisplay: true,
          ...(independentAgentModelCatalog(record.provider) ? { workspacePath: null } : {})
        }),
        await readCatalog(false))
      : scoped
  // With no catalog for the account, the list a running child of this agent falls back to.
  const listed = catalog.origin === 'unknown' ? (rules?.fallbackModels() ?? null) : catalog.models
  const models = listed ?? []
  const proof = independentAgentModelCatalog(record.provider)
    ? await deps.modelCatalog
        ?.read({
          agent: record.provider,
          sessionId,
          savedOnly: true,
          verifiedOnly: true,
          inSessionWorkspace: true
        })
        .catch(() => null)
    : catalog
  const listedModelIds = proof ? finishedListingIds(proof) : undefined
  const defaultModels =
    independentAgentModelCatalog(record.provider) && reader.readsWithoutModel
      ? proof && proof.origin !== 'unknown'
        ? proof.models
        : []
      : models
  const fastMode =
    saved.fastMode === undefined
      ? rules?.acceptsKey('fastMode')
        ? false
        : null
      : decodeStructuredAgentSessionOptionValue('fastMode', saved.fastMode)
  // An unknown model is one the client already treats as unconfirmed. Only a real listing names the
  // account's default; a built-in list's default is a guess, so with none the client keeps its own.
  const model =
    saved.model ??
    (catalog.origin === 'unknown' ? undefined : models.find((entry) => entry.isDefault)?.id)
  // The pick, else the model's default where a live child reports that, or where the chat's folder
  // names that model as what it runs, as its first frame showed.
  const effort =
    saved.effort ??
    (rules?.effortDefaultsToModel || (saved.model === undefined && folderDefault)
      ? defaultModels.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  const defaulted = (['model', 'effort'] as const).filter(
    (key) => saved[key] === undefined && Boolean(key === 'model' ? model : effort)
  )
  // The tier the chat's own model runs; the record keeps the saved one for a model that offers it.
  const serviceTier = savedEffectiveServiceTier(saved, models)
  return {
    inventory: catalog,
    fallback: catalog.origin === 'unknown' ? (listed ?? []) : [],
    models: listed ? structuredAgentSessionOptionModels(listed, model, (row) => row) : [],
    ...(catalog.origin !== 'unknown' && catalog.fastModeSupport
      ? { fastModeSupport: catalog.fastModeSupport }
      : {}),
    ...(listedModelIds ? { listedModelIds } : {}),
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      defaulted
    }
  }
}
