import { AGENT_MODEL_CATALOG_PICKER_WAIT_MS } from '../agent-model-catalog/agent-model-catalog-listing-waiters'
import { independentAgentModelCatalog } from '../agent-model-catalog/agent-model-catalog-discovery'
import {
  readStructuredAgentSessionOptionsAtRest,
  IN_PROCESS_OPTIONS_READER,
  type StructuredAgentSessionOptionsReader
} from './structured-agent-session-resting-options'
export { IN_PROCESS_OPTIONS_READER, type StructuredAgentSessionOptionsReader }
import { structuredAgentSessionThreadGoalReport } from './structured-agent-session-thread-goal'
// Saved choices, catalog defaults and actual execution reports remain separate facts.

import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import {
  structuredAgentSessionCapabilityView,
  type StructuredAgentSessionRestingOptions as RestingOptions
} from './structured-agent-session-option-models'
import { structuredAgentSessionImmediatePermission } from './structured-agent-session-launch-permission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { structuredAgentSessionNeverSent } from './structured-agent-session-never-sent'

export {
  recordStructuredAgentSessionOptionIntent,
  structuredAgentSessionOptionOverridesRefusal
} from './structured-agent-session-option-intent'

/** A live child's own answer, or the answer at rest; the goal, usage and rewind either way. */
export async function readStructuredAgentSessionOptions(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'deps' | 'serialize' | 'openConversation' | 'conversation'
  >,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<AgentSessionOptionsResult> {
  reader = reader.readsWithoutModel
    ? reader
    : { ...reader, deadline: reader.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS }
  const { adapter, agents, store } = context.deps
  const started = await context.serialize(sessionId, async () => {
    const session = await context.openConversation(sessionId).catch((error: unknown) => {
      throw journalOpenReadRefusal(error, context.deps.logger, sessionId)
    })
    const child = session?.child
    if (!child || child.phase === 'starting') {
      return { kind: 'rest' as const }
    }
    if (!adapter.readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    return {
      kind: 'live' as const,
      session,
      child,
      options: await adapter.readOptions({ sessionId, fence: child.fence })
    }
  })
  const live: StructuredAgentSessionLiveOptions | null =
    started.kind === 'live' ? started.options : null
  let rested: RestingOptions | undefined
  const atRest = async (): Promise<RestingOptions> =>
    (rested ??= await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId, reader))
  let options: Omit<AgentSessionOptionsResult, 'rewind'>
  if (live) {
    const { catalogListing, ...answer } = live
    options = answer
    // Fill missing live listings from saved catalog state; absent records keep the child’s answer.
    if (!catalogListing && !answer.listedModelIds && store.getConversation(sessionId)) {
      const { listedModelIds } = await atRest()
      options = listedModelIds ? { ...answer, listedModelIds } : answer
    }
  } else {
    const { inventory: _inventory, fallback: _fallback, ...answer } = await atRest()
    options = answer
  }
  // Earlier reads may have closed/reopened the handle.
  const session = await context.conversation(sessionId)
  const record = store.getConversation(sessionId)
  const phase = record?.rewind?.phase
  const agent = session.params.provider
  const capabilities = agents.capabilities(agent)
  const floor = session.journal.context.floor()
  const contextFloor = floor ? { contextFloor: floor } : {}
  const permissionMode = record
    ? structuredAgentSessionImmediatePermission(context.deps, record)
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
  const defaulted =
    (agent !== 'codex' || !live || options.current.model) &&
    structuredAgentSessionNeverSent(record, session.journal)
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
    const projected =
      live && (saved.serviceTier !== undefined || saved.fastMode !== undefined)
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
      ...(permissionMode ? { permissionMode } : {}),
      ...(live && options.current.reportedPermissionMode !== undefined
        ? { reportedPermissionMode: options.current.reportedPermissionMode }
        : { reportedPermissionMode: undefined })
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
