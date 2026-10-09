// A chat's options, live or at rest.
//
// At rest nothing here needs a child. The pick is the record's own `options` — what the next start replays —
// and the list is the host's model catalog, the same one the picker already reads before a chat
// exists. A pick made at rest is written to the record as intent, through the same transition a live
// pick takes, so the next start applies it.

import {
  refuse,
  type AgentSessionOptionResult,
  type AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModeSupported
} from '../../../shared/agent-chat-permission-mode'
import {
  readStructuredAgentSessionPermissionFact,
  restingPermissionModes
} from './structured-agent-session-permission-fact'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { structuredAgentSessionOptionModels } from './structured-agent-session-option-models'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

type RestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'fastModeSupport' | 'current' | 'permissionModes'
>

/** The at-rest rules of the record's agent, as this runtime registered it; null for any other. */
function restingOptionRules(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  record: AgentSessionRecord
): StructuredAgentDefinition['restingOptions'] | null {
  return agents.definition(record.provider)?.restingOptions ?? null
}

export async function readStructuredAgentSessionOptionsAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'modelCatalog'> &
    Partial<Pick<StructuredAgentSessionHostDeps, 'logger'>> & {
      store: Pick<AgentSessionRecordStore, 'getRecord'>
      agents: Pick<StructuredAgentRegistry, 'definition'>
    },
  sessionId: string
): Promise<RestingOptions> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const rules = restingOptionRules(deps.agents, record)
  const catalog = (await deps.modelCatalog
    ?.read({ agent: record.provider, sessionId })
    .catch(() => null)) ?? { origin: 'unknown' as const }
  // With no catalog for the account, the list a running child of this agent falls back to.
  const listed = catalog.origin === 'unknown' ? (rules?.fallbackModels() ?? null) : catalog.models
  const models = listed ?? []
  const saved = record.options ?? {}
  const fastMode =
    saved.fastMode === undefined
      ? null
      : decodeStructuredAgentSessionOptionValue('fastMode', saved.fastMode)
  // An unknown model is one the client already treats as unconfirmed. Only a real listing names the
  // account's default; a built-in list's default is a guess, so with none the client keeps its own.
  const model =
    saved.model ??
    (catalog.origin === 'unknown' ? undefined : models.find((entry) => entry.isDefault)?.id)
  // As a live child answers: the pick, else the model's default where the agent reports that.
  const effort =
    saved.effort ??
    (rules?.effortDefaultsToModel
      ? models.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  const permissionModes = restingPermissionModes(record, deps.logger)
  return {
    models: listed ? structuredAgentSessionOptionModels(listed, model, (row) => row) : [],
    ...(permissionModes ? { permissionModes } : {}),
    ...(catalog.origin !== 'unknown' && catalog.fastModeSupport
      ? { fastModeSupport: catalog.fastModeSupport }
      : {}),
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {})
    }
  }
}

/** Records a pick for the next start. Only a key the provider would accept is kept. */
export async function recordStructuredAgentSessionOptionIntent(
  deps: Pick<StructuredAgentSessionHostDeps, 'modelCatalog'> & {
    store: Pick<AgentSessionRecordStore, 'getRecord'>
    agents: Pick<StructuredAgentRegistry, 'definition'>
  },
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'persistOptions' | 'publish'>,
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const record = deps.store.getRecord(ctx.sessionId)
  const rules = record ? restingOptionRules(deps.agents, record) : null
  try {
    input = rules?.normalizePick?.(input.key, input.value) ?? input
  } catch (error) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  if (
    !record ||
    !rules?.acceptsKey(input.key) ||
    (input.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
      !agentChatPermissionModeSupported(record.provider, input.value))
  ) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        `${record?.provider ?? 'This session'} has no session option named ${input.key}`
      )
    }
  }
  const options = {
    ...(rules?.normalizeOptions?.(record.options) ?? record.options),
    [input.key]: input.value
  }
  await ctx.persistOptions(options)
  ctx.publish()
  return { ok: true, value: { ...input, options } }
}

/** A live child's own answer, or the answer at rest; the goal, usage and rewind either way. */
export async function readStructuredAgentSessionOptions(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'deps' | 'serialize' | 'openConversation' | 'conversation'
  >,
  sessionId: string
): Promise<AgentSessionOptionsResult> {
  const { adapter, agents, store } = context.deps
  const started = await context.serialize(sessionId, async () => {
    const session = await context.openConversation(sessionId).catch((error: unknown) => {
      throw journalOpenReadRefusal(error, context.deps.logger, sessionId)
    })
    const child = session?.child
    if (!child) {
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
  let options: Omit<AgentSessionOptionsResult, 'rewind'>
  if (live) {
    const { catalogListing, ...answer } = live
    if (catalogListing) {
      // What a running child listed is its account's catalog too, so the next chat opens warm.
      context.deps.modelCatalog?.recordLiveListing(sessionId, catalogListing)
    }
    options = answer
  } else {
    options = await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId)
  }
  // Re-acquired after the reads above: the handle they saw may have closed and reopened since.
  const session = await context.conversation(sessionId)
  const phase = store.getRecord(sessionId)?.rewind?.phase
  const agent = session.params.provider
  const capabilities = agents.capabilities(agent)
  const { permissionModes, ...otherOptions } = options
  const fact = permissionModes
    ? readStructuredAgentSessionPermissionFact(context.deps, sessionId)
    : undefined
  const floor = session.journal.context.floor()
  const contextFloor = floor ? { contextFloor: floor } : {}
  return {
    ...otherOptions,
    ...(permissionModes && fact
      ? {
          permissionModes: {
            ...permissionModes,
            current: fact.mode ?? permissionModes.current,
            fence: fact.fence,
            revision: fact.revision
          }
        }
      : {}),
    rewind:
      phase === 'prepared' || phase === 'provider-succeeded'
        ? { supported: false, reason: 'outcome-unknown' }
        : (adapter.rewindSupport?.(sessionId, agent) ?? {
            supported: false,
            reason: 'unsupported'
          }),
    conversationCommands: capabilities?.compact ? ['clear', 'compact'] : ['clear'],
    ...(capabilities?.threadGoal
      ? { threadGoal: { current: session.journal.threadGoal(), ...contextFloor } }
      : {}),
    ...(capabilities?.contextUsage
      ? { contextUsage: { current: session.journal.contextUsage(), ...contextFloor } }
      : {})
  }
}
