// A chat's options, live or at rest.
//
// The record keeps the next message's choices; the catalog names known defaults. A provider's
// reports remain execution facts and never replace the saved selection.

import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentJournalCursor,
  AgentJournalThreadGoal
} from '../../../shared/agent-session-journal-types'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import { finishedListingIds } from '../../../shared/structured-agent-session-options'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import { retainedAgentModelCatalogModels } from '../agent-model-catalog/agent-model-catalog-entry'
import { saveStructuredAgentSessionListing } from './structured-agent-session-start-listing'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { structuredAgentSessionOptionModels } from './structured-agent-session-option-models'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { structuredAgentSessionNeverSent } from './structured-agent-session-never-sent'

export {
  recordStructuredAgentSessionOptionIntent,
  structuredAgentSessionOptionOverridesRefusal
} from './structured-agent-session-option-intent'

type RestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'listedModelIds' | 'fastModeSupport' | 'current'
>

/** What the asking client takes: whether it reads an answer that names no model. */
export type StructuredAgentSessionOptionsReader = { readsWithoutModel: boolean }

/** A same-build caller in this process reads as the RPC gate treats one: it takes no model. */
export const IN_PROCESS_OPTIONS_READER: StructuredAgentSessionOptionsReader = {
  readsWithoutModel: true
}

/** The at-rest rules of the record's agent, as this runtime registered it; null for any other. */
function restingOptionRules(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  record: AgentSessionRecord
): StructuredAgentDefinition['restingOptions'] | null {
  return agents.definition(record.provider)?.restingOptions ?? null
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
  const rules = restingOptionRules(deps.agents, record)
  const readCatalog = async (
    inSessionWorkspace: boolean
  ): Promise<AgentSessionModelCatalogResult> =>
    (await deps.modelCatalog
      ?.read({
        agent: record.provider,
        sessionId,
        savedOnly: true,
        ...(inSessionWorkspace ? { inSessionWorkspace: true as const } : {})
      })
      .catch(() => null)) ?? { origin: 'unknown' }
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
      ? await readCatalog(false)
      : scoped
  // With no catalog for the account, the list a running child of this agent falls back to.
  const listed = catalog.origin === 'unknown' ? (rules?.fallbackModels() ?? null) : catalog.models
  const models = listed ?? []
  const listedModelIds = finishedListingIds(catalog)
  const fastMode =
    saved.fastMode === undefined
      ? null
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
      ? models.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  const defaulted = (['model', 'effort'] as const).filter(
    (key) => saved[key] === undefined && Boolean(key === 'model' ? model : effort)
  )
  // The tier the chat's own model runs; the record keeps the saved one for a model that offers it.
  const serviceTier = savedEffectiveServiceTier(saved, models)
  return {
    models: listed ? structuredAgentSessionOptionModels(listed, model, (row) => row) : [],
    ...(listedModelIds ? { listedModelIds } : {}),
    ...(catalog.origin !== 'unknown' && catalog.fastModeSupport
      ? { fastModeSupport: catalog.fastModeSupport }
      : {}),
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      defaulted
    }
  }
}

/** A live child's own answer, or the answer at rest; the goal, usage and rewind either way. */
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
    // A starting child is asked nothing: the answer is the saved intent and the catalog.
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
    // A child with no listing of its own reads the saved one, as at rest, so a row reads the same.
    // With no record there is nothing saved to read, and the answer stays the child's own.
    if (!catalogListing && !answer.listedModelIds && store.getRecord(sessionId)) {
      const { listedModelIds } = await atRest()
      options = listedModelIds ? { ...answer, listedModelIds } : answer
    }
    if (catalogListing) {
      // Check prior membership before saving: a launch-added row cannot verify itself.
      const listedModelIds = context.deps.modelCatalog
        ? await context.deps.modelCatalog.retainedLiveModelIds(sessionId, catalogListing)
        : retainedAgentModelCatalogModels(undefined, catalogListing).map((model) => model.id)
      saveStructuredAgentSessionListing(context, sessionId, catalogListing)
      options = { ...answer, listedModelIds }
    }
  } else {
    options = await atRest()
  }
  // Re-acquired after the reads above: the handle they saw may have closed and reopened since.
  const session = await context.conversation(sessionId)
  const record = store.getRecord(sessionId)
  const phase = record?.rewind?.phase
  const agent = session.params.provider
  const capabilities = agents.capabilities(agent)
  const floor = session.journal.context.floor()
  const contextFloor = floor ? { contextFloor: floor } : {}
  // What a start launches now, live or at rest: a child never reports it.
  const permissionMode = record
    ? await structuredAgentSessionLaunchPermission(context.deps, record)
    : null
  const selected = live ? await atRest() : options
  // The saved pick shows, except a model the running child could not take (its provider says it
  // does not exist): that shows what the child runs instead.
  const refusedModel = live && !!adapter.readOptionRestoreFailures?.(sessionId).includes('model')
  const saved = record?.options ?? {}
  const { model: _refused, ...selectedWithoutModel } = selected.current
  const model = refusedModel
    ? options.current.model
    : (saved.model ?? (options.current.model || selected.current.model))
  const current = {
    ...(refusedModel ? selectedWithoutModel : selected.current),
    ...options.current,
    ...(model !== undefined ? { model } : {}),
    effort: saved.effort ?? options.current.effort,
    fastMode:
      saved.fastMode !== undefined
        ? selected.current.fastMode
        : (options.current.fastMode ?? selected.current.fastMode),
    // The saved tier as the shared speed rule runs it under the saved model.
    serviceTier:
      saved.serviceTier !== undefined
        ? selected.current.serviceTier
        : (options.current.serviceTier ?? selected.current.serviceTier)
  }
  // A chat that saved a value has no default for it: the saved value shows, or the child it
  // refused runs what it reports. A chat that has sent nothing runs the default it shows, which its
  // first send pins. A model the child leaves blank shows the at-rest one, with its marking.
  const defaultedBy = (key: 'model' | 'effort') =>
    (key === 'model' && !options.current.model ? selected : options).current.defaulted
  const defaulted = structuredAgentSessionNeverSent(record, session.journal)
    ? []
    : (['model', 'effort'] as const).filter(
        (key) => saved[key] === undefined && defaultedBy(key)?.includes(key) === true
      )
  const confirmed = options.current.confirmed?.filter((key) =>
    key === 'model' || key === 'effort' || key === 'fastMode' || key === 'serviceTier'
      ? current[key] === options.current[key]
      : false
  )
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
    // A live child may narrow what its agent declares, never widen it.
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

/** A goal the host can change, or one only the agent's own `/goal` changes, reported apart. */
function structuredAgentSessionThreadGoalReport(
  hostChangesGoal: boolean,
  current: AgentJournalThreadGoal | null,
  contextFloor: { contextFloor?: AgentJournalCursor }
): Pick<AgentSessionOptionsResult, 'threadGoal' | 'reportedThreadGoal'> {
  if (hostChangesGoal) {
    return { threadGoal: { current, ...contextFloor } }
  }
  return current ? { reportedThreadGoal: { current, ...contextFloor } } : {}
}
