import { structuredAgentSessionThreadGoalReport } from './structured-agent-session-thread-goal'
// Saved choices, catalog defaults and actual execution reports remain separate facts.

import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import { finishedListingIds } from '../../../shared/structured-agent-session-options'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import { retainedAgentModelCatalogModels } from '../agent-model-catalog/agent-model-catalog-entry'
import { saveStructuredAgentSessionListing } from './structured-agent-session-start-listing'
import { independentAgentModelCatalog } from '../agent-model-catalog/agent-model-catalog-discovery'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  structuredAgentSessionCapabilityView,
  structuredAgentSessionOptionModels,
  type StructuredAgentSessionRestingOptions as RestingOptions
} from './structured-agent-session-option-models'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { structuredAgentSessionNeverSent } from './structured-agent-session-never-sent'

export {
  recordStructuredAgentSessionOptionIntent,
  structuredAgentSessionOptionOverridesRefusal
} from './structured-agent-session-option-intent'

/** Whether a client accepts answers without a model. */
export type StructuredAgentSessionOptionsReader = { readsWithoutModel: boolean }

/** Match same-build RPC support for model-less answers. */
export const IN_PROCESS_OPTIONS_READER: StructuredAgentSessionOptionsReader = {
  readsWithoutModel: true
}

async function readStructuredAgentSessionOptionsAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'agents' | 'modelCatalog'>,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<RestingOptions> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
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
  const saved = record.options ?? {}
  const scoped = await readCatalog(true)
  const folderDefault =
    scoped.origin === 'unknown' ? undefined : scoped.models.find((entry) => entry.isDefault)
  // Older clients requiring a model retain the account default when the folder has none.
  const catalog =
    saved.model === undefined &&
    !folderDefault &&
    scoped.origin !== 'unknown' &&
    !reader.readsWithoutModel
      ? await readCatalog(false)
      : scoped
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
      ? null
      : decodeStructuredAgentSessionOptionValue('fastMode', saved.fastMode)
  // Only a real listing confirms account defaults; built-in defaults cannot override client state.
  const model =
    saved.model ??
    (catalog.origin === 'unknown' ? undefined : models.find((entry) => entry.isDefault)?.id)
  // Prefer saved effort, then live execution or the folder’s matching model default.
  const effort =
    saved.effort ??
    (rules?.effortDefaultsToModel || (saved.model === undefined && folderDefault)
      ? defaultModels.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  const defaulted = (['model', 'effort'] as const).filter(
    (key) => saved[key] === undefined && Boolean(key === 'model' ? model : effort)
  )
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

export async function readStructuredAgentSessionOptions(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'deps' | 'serialize' | 'openConversation' | 'conversation'
  >,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<AgentSessionOptionsResult> {
  const { adapter, agents, store } = context.deps
  const started = await context.serialize(sessionId, async () => {
    const session = await context.openConversation(sessionId).catch((error: unknown) => {
      throw journalOpenReadRefusal(error, context.deps.logger, sessionId)
    })
    const child = session?.child
    if (!child || child.phase === 'starting') {
      return { kind: 'rest' as const }
    }
    const prepared = adapter.prepareReadOptions?.({ sessionId, fence: child.fence })
    if (prepared) {
      return { kind: 'prepared' as const, child, prepared }
    }
    if (!adapter.readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    return {
      kind: 'live' as const,
      child,
      options: await adapter.readOptions({ sessionId, fence: child.fence })
    }
  })
  const live: StructuredAgentSessionLiveOptions | null =
    started.kind === 'live'
      ? started.options
      : started.kind === 'prepared'
        ? await started.prepared.then((apply) =>
            context.serialize(sessionId, async () => {
              const child = (await context.openConversation(sessionId))?.child
              return child === started.child ? apply() : null
            })
          )
        : null
  let rested: RestingOptions | undefined
  const atRest = async (): Promise<RestingOptions> =>
    (rested ??= await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId, reader))
  let options: Omit<AgentSessionOptionsResult, 'rewind'>
  if (live) {
    const { catalogListing, ...answer } = live
    options = answer
    // Fill missing live listings from saved catalog state; absent records keep the child’s answer.
    if (!catalogListing && !answer.listedModelIds && store.getRecord(sessionId)) {
      const { listedModelIds } = await atRest()
      options = listedModelIds ? { ...answer, listedModelIds } : answer
    }
    if (
      catalogListing &&
      !independentAgentModelCatalog(store.getRecord(sessionId)?.provider ?? '')
    ) {
      // Check prior membership before saving: a launch-added row cannot verify itself.
      const listedModelIds = context.deps.modelCatalog
        ? await context.deps.modelCatalog.retainedLiveModelIds(sessionId, catalogListing)
        : retainedAgentModelCatalogModels(undefined, catalogListing).map((model) => model.id)
      saveStructuredAgentSessionListing(context, sessionId, catalogListing)
      options = { ...answer, listedModelIds }
    }
  } else {
    const { inventory: _inventory, fallback: _fallback, ...answer } = await atRest()
    options = answer
  }
  // Earlier reads may have closed/reopened the handle.
  const session = await context.conversation(sessionId)
  const record = store.getRecord(sessionId)
  const phase = record?.rewind?.phase
  const agent = session.params.provider
  const capabilities = agents.capabilities(agent)
  const floor = session.journal.context.floor()
  const contextFloor = floor ? { contextFloor: floor } : {}
  // Derive launch mode consistently; children never report it.
  const permissionMode = record
    ? await structuredAgentSessionLaunchPermission(context.deps, record)
    : null
  const resting = live ? await atRest() : null
  const selected = resting ?? options
  const independent = independentAgentModelCatalog(agent)
  const displayDefault =
    resting && independent
      ? (resting.inventory.origin === 'unknown' ? resting.fallback : resting.inventory.models).find(
          (row) => row.isDefault
        )?.id
      : undefined
  // Show saved intent unless the provider explicitly rejected that model; then show execution.
  const refusedModel = live && !!adapter.readOptionRestoreFailures?.(sessionId).includes('model')
  const saved = record?.options ?? {}
  const { model: _refused, ...selectedWithoutModel } = selected.current
  const model = refusedModel
    ? (options.current.model ?? displayDefault)
    : (saved.model ?? (options.current.model || selected.current.model || displayDefault))
  const current = {
    ...(refusedModel ? selectedWithoutModel : selected.current),
    ...options.current,
    ...(model !== undefined ? { model } : {}),
    effort: saved.effort ?? options.current.effort,
    fastMode:
      saved.fastMode !== undefined
        ? selected.current.fastMode
        : (options.current.fastMode ?? selected.current.fastMode),
    serviceTier:
      saved.serviceTier !== undefined
        ? selected.current.serviceTier
        : (options.current.serviceTier ?? selected.current.serviceTier)
  }
  // Defaults cover unsaved choices only; first send pins them.
  const defaultedBy = (key: 'model' | 'effort') =>
    key === 'model' && !options.current.model
      ? displayDefault !== undefined || selected.current.defaulted?.includes(key) === true
      : options.current.defaulted?.includes(key) === true
  const defaulted = structuredAgentSessionNeverSent(record, session.journal)
    ? []
    : (['model', 'effort'] as const).filter((key) => saved[key] === undefined && defaultedBy(key))
  const confirmed = options.current.confirmed?.filter((key) =>
    key === 'model' || key === 'effort' || key === 'fastMode' || key === 'serviceTier'
      ? current[key] === options.current[key]
      : false
  )
  if (independent) {
    const { inventory, fallback, listedModelIds } = await atRest()
    if (saved.model === undefined && current.model && inventory.origin !== 'unknown') {
      current.model =
        inventory.models.find(
          (row) => row.id === current.model || row.resolvedModel === current.model
        )?.id ?? current.model
    }
    const { listedServiceTiers: _tiers, ...view } = structuredAgentSessionCapabilityView(
      inventory,
      current.model,
      fallback,
      live?.fastModeSupport?.supported === false &&
        live.fastModeSupport.reason !== 'model-not-supported'
        ? live.fastModeSupport
        : undefined
    )
    options = { ...options, ...view, listedModelIds, current }
    const projected = live
      ? adapter.projectOptions?.(sessionId, {
          ...saved,
          ...(model ? { model } : {})
        })
      : undefined
    if (projected?.options.serviceTier !== undefined) {
      current.serviceTier = projected.options.serviceTier
    }
  }
  return {
    ...options,
    current: {
      ...current,
      defaulted,
      confirmed,
      ...(options.current.fastModeState ? { fastModeState: options.current.fastModeState } : {}),
      ...(confirmed?.length ? { confirmed } : {}),
      ...(permissionMode ? { permissionMode } : {})
    },
    rewind:
      phase === 'prepared' || phase === 'provider-succeeded'
        ? { supported: false, reason: 'outcome-unknown' }
        : (adapter.rewindSupport?.(sessionId, agent) ?? {
            supported: false,
            reason: 'unsupported'
          }),
    conversationCommands: capabilities?.compact ? ['clear', 'compact'] : ['clear'],
    // Live children may narrow declared capabilities, never expand them.
    acceptsImages: capabilities?.imagePrompts === true && options.acceptsImages !== false,
    ...structuredAgentSessionThreadGoalReport(
      capabilities?.threadGoal === true,
      session.journal.threadGoal(),
      contextFloor
    ),
    ...(capabilities?.contextUsage
      ? { contextUsage: { current: session.journal.contextUsage(), ...contextFloor } }
      : {})
  }
}
