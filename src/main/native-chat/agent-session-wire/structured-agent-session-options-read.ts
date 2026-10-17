import { providerChildRootExited } from './structured-agent-session-provider-child'
// A chat's options, live or at rest.
//
// At rest nothing here needs a child. The pick is the record's own `options` — what the next start replays —
// and the list is the host's model catalog, the same one the picker already reads before a chat
// exists. A pick made at rest is written to the record as intent, through the same transition a live
// pick takes, so the next start applies it.

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
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import { retainedAgentModelCatalogModels } from '../agent-model-catalog/agent-model-catalog-entry'
import { saveStructuredAgentSessionListing } from './structured-agent-session-start-listing'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { structuredAgentSessionOptionModels } from './structured-agent-session-option-models'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
export {
  recordStructuredAgentSessionOptionIntent,
  structuredAgentSessionOptionOverridesRefusal
} from './structured-agent-session-option-intent'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

type RestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'listedModelIds' | 'fastModeSupport' | 'current' | 'choiceCatalog' | 'choiceAuthority'
>

/** What the asking client takes: whether it reads an answer that names no model. */
export type StructuredAgentSessionOptionsReader = {
  readsWithoutModel: boolean
  readsCoherentCatalog?: boolean
}

/** A same-build caller in this process reads as the RPC gate treats one: it takes no model. */
export const IN_PROCESS_OPTIONS_READER: StructuredAgentSessionOptionsReader = {
  readsWithoutModel: true,
  readsCoherentCatalog: true
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
        ...(inSessionWorkspace
          ? { inSessionWorkspace: true as const }
          : { accountDefault: true as const })
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
    (reader.readsCoherentCatalog || catalog.origin === 'unknown'
      ? undefined
      : models.find((entry) => entry.isDefault)?.id)
  // The pick, else the model's default where a live child reports that, or where the chat's folder
  // names that model as what it runs, as its first frame showed.
  const effort =
    saved.effort ??
    (rules?.effortDefaultsToModel || (saved.model === undefined && folderDefault)
      ? models.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  return {
    ...(reader.readsCoherentCatalog && catalog.choiceCatalog
      ? { choiceCatalog: catalog.choiceCatalog, choiceAuthority: catalog.choiceCatalog.authority }
      : {}),
    models: listed ? structuredAgentSessionOptionModels(listed, model, (row) => row) : [],
    ...(listedModelIds ? { listedModelIds } : {}),
    ...(catalog.origin !== 'unknown' && catalog.fastModeSupport
      ? { fastModeSupport: catalog.fastModeSupport }
      : {}),
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
      ...(saved.serviceTier ? { serviceTier: saved.serviceTier } : {})
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
    if (!child || child.phase === 'starting' || providerChildRootExited(session)) {
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
  let live: StructuredAgentSessionLiveOptions | null =
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
  const activeSession = await context.conversation(sessionId)
  if (
    started.kind !== 'rest' &&
    (activeSession.child !== started.child || providerChildRootExited(activeSession))
  ) {
    live = null
  }
  let options: Omit<AgentSessionOptionsResult, 'rewind'>
  if (live) {
    const { catalogListing, ...answer } = live
    options = answer
    if (!catalogListing) {
      context.deps.modelCatalog?.recordLiveListing(sessionId, { models: [], complete: false })
    }
    if (catalogListing) {
      // Check prior membership before saving: a launch-added row cannot verify itself.
      const listedModelIds = context.deps.modelCatalog
        ? context.deps.modelCatalog.retainedLiveModelIds(sessionId, catalogListing)
        : retainedAgentModelCatalogModels(undefined, catalogListing).map((model) => model.id)
      saveStructuredAgentSessionListing(context, sessionId, catalogListing)
      options = { ...answer, listedModelIds }
    }
  } else {
    options = await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId, reader)
  }
  if (live && reader.readsCoherentCatalog) {
    const process = context.deps.modelCatalog?.processCatalog(sessionId)
    options = {
      ...options,
      choiceAuthority: process ? 'session' : 'discovery',
      ...(process ? { choiceCatalog: process } : {})
    }
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
  const saved = record?.options
  const selected =
    live && (saved?.model !== undefined || saved?.effort !== undefined)
      ? await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId, reader)
      : options
  const current = {
    ...options.current,
    ...(saved?.model !== undefined ? { model: selected.current.model } : {}),
    ...(saved?.effort !== undefined ? { effort: selected.current.effort } : {})
  }
  const confirmed = current.confirmed?.filter((key) =>
    key === 'model'
      ? current.model === options.current.model
      : key !== 'effort' || current.effort === options.current.effort
  )
  return {
    ...options,
    current: {
      ...current,
      ...(confirmed ? { confirmed } : {}),
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
