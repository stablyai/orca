import { readAcpForkSupport } from '../../../acp/capabilities/acp-fork-support'
import { supportsSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import { structuredAgentSessionCatalogScopeOwned } from './structured-agent-session-catalog-reads'
import { withinAgentModelCatalogRead } from '../../agent-model-catalog/agent-model-catalog-operation'
import { AGENT_MODEL_CATALOG_PICKER_WAIT_MS } from '../../agent-model-catalog/agent-model-catalog-listing-waiters'
import {
  independentAgentModelCatalog,
  usesModelSpecificAcpEfforts
} from '../../../../shared/agent-session/options/agent-model-catalog-ownership'
import {
  readStructuredAgentSessionOptionsAtRest,
  type StructuredAgentSessionOptionsReader
} from './structured-agent-session-resting-options'

import { structuredAgentSessionThreadGoalReport } from '../operations/structured-agent-session-thread-goal'
// Saved choices, catalog defaults and actual execution reports remain separate facts.

import type {
  AgentSessionOptionsResult,
  AgentSessionAcceptedInputSources
} from '../../../../shared/agent-session/options/agent-session-options-result'
import { journalOpenReadRefusal } from '../../agent-session-journal/replay/journal-open-failure'
import {
  confirmedCurrentOptions,
  structuredAgentSessionCapabilityView,
  type StructuredAgentSessionLiveOptions,
  type StructuredAgentSessionRestingOptions as RestingOptions
} from './structured-agent-session-option-models'
import { structuredAgentSessionImmediatePermission } from './structured-agent-session-launch-permission'
import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import { readStructuredSessionRecovery } from '../recovery/structured-agent-session-recovery-read'
import { fillUnknownModelEfforts } from '../../../../shared/agent-session/options/agent-session-model-efforts'

/** A live child's own answer, or the answer at rest; the goal, usage and rewind either way. */
export async function readStructuredAgentSessionOptions(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'deps' | 'serialize' | 'openConversation' | 'conversation'
  > &
    Partial<Pick<StructuredAgentSessionMutationContext, 'deliveryOrder'>>,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<AgentSessionOptionsResult> {
  reader = reader.readsWithoutModel
    ? reader
    : { ...reader, deadline: reader.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS }
  const { adapter, agents, store } = context.deps
  const operation = context.deps.modelCatalog?.captureRead({
    agent: context.deps.store.getConversation(sessionId)?.provider ?? '',
    sessionId,
    savedOnly: reader.readsWithoutModel,
    deadline: reader.deadline
  })
  const readCurrent = (allowJoin: boolean) =>
    context.serialize(sessionId, async () => {
      const session = await context.openConversation(sessionId).catch((error: unknown) => {
        throw journalOpenReadRefusal(error, context.deps.logger, sessionId)
      })
      const child = session?.child
      if (child && child.phase !== 'starting' && !adapter.readOptions) {
        throw new Error('structured_agent_session_options_unsupported')
      }
      const pending =
        child && child.phase !== 'starting' && allowJoin
          ? context.deliveryOrder?.optionsReady(sessionId)
          : undefined
      if (pending) {
        return { kind: 'pending' as const, pending, records: undefined }
      }
      const observed =
        child && child.phase !== 'starting'
          ? await adapter.readOptions?.({ sessionId, fence: child.fence })
          : undefined
      const scope = () =>
        structuredAgentSessionCatalogScopeOwned(
          context.deps,
          {
            agent: context.deps.store.getConversation(sessionId)?.provider ?? '',
            sessionId
          },
          session ?? undefined
        )
      const records = context.deps.modelCatalog
        ? operation
          ? await withinAgentModelCatalogRead(operation, scope)
          : await scope()
        : undefined
      if (!child || child.phase === 'starting') {
        return { kind: 'rest' as const, records }
      }
      return {
        kind: 'live' as const,
        records,
        session,
        child,
        options: observed ?? null
      }
    })
  let started = await readCurrent(true)
  if (started.kind === 'pending') {
    await started.pending.catch(() => undefined)
    started = await readCurrent(false)
  }
  const catalogScope = { records: started?.records ?? null, operation }
  const live: StructuredAgentSessionLiveOptions | null =
    started?.kind === 'live' ? started.options : null
  let rested: RestingOptions | undefined
  const atRest = async (): Promise<RestingOptions> =>
    (rested ??= await readStructuredAgentSessionOptionsAtRest(
      context.deps,
      sessionId,
      reader,
      catalogScope
    ))
  let options: Omit<AgentSessionOptionsResult, 'rewind'>
  if (live) {
    const { catalogListing, effortFixed: _fixed, projectCurrent: _project, ...answer } = live
    options = answer
    // Fill missing live listings from saved catalog state; absent records keep the child’s answer.
    if (!catalogListing && !answer.listedModelIds && store.getConversation(sessionId)) {
      const { listedModelIds } = await atRest()
      options = listedModelIds ? { ...answer, listedModelIds } : answer
    }
  } else {
    const { inventory, fallback: _fallback, ...answer } = await atRest()
    options = { ...answer, ...(inventory.origin === 'unknown' ? { modelsKnown: false } : {}) }
  }
  // Earlier reads may have closed/reopened the handle.
  const session = await context.conversation(sessionId)
  const agent = session.params.provider
  const capabilities = agents.capabilities(agent)
  const floor = session.journal.context.floor()
  const contextFloor = floor ? { contextFloor: floor } : {}
  const restingOptions = await atRest()
  const recovery = await readStructuredSessionRecovery(session, context, sessionId)
  if (live && usesModelSpecificAcpEfforts(agent)) {
    options = {
      ...options,
      models: fillUnknownModelEfforts(
        options.models,
        restingOptions.inventory.origin === 'unknown' ? [] : restingOptions.inventory.models
      )
    }
  }
  const resting = live ? restingOptions : null
  const record = store.getConversation(sessionId)
  const permissionMode = record
    ? structuredAgentSessionImmediatePermission(context.deps, record)
    : null
  const phase = record?.rewind?.phase
  const selected = resting ?? options
  const independent = independentAgentModelCatalog(agent)
  const displayDefault =
    resting && independent
      ? (resting.inventory.origin === 'unknown' ? resting.fallback : resting.inventory.models).find(
          (row) => row.isDefault
        )?.id
      : undefined
  const saved = record?.options ?? {}
  const model = saved.model ?? (options.current.model || selected.current.model || displayDefault)
  const projected = live?.projectCurrent?.({ ...saved, ...(model ? { model } : {}) })
  const reportedEffort = projected?.confirmed?.includes('effort') ? projected.effort : undefined
  const current = {
    ...selected.current,
    ...options.current,
    ...(model !== undefined ? { model } : {}),
    effort: saved.effort ?? options.current.effort,
    fastMode: selected.current.fastMode ?? options.current.fastMode,
    // The saved tier as the shared speed rule runs it under the saved model.
    ...(context.deps.agents.definition(agent)?.restingOptions.acceptsKey('interactionMode')
      ? {
          interactionMode:
            saved.interactionMode === 'plan' ? ('plan' as const) : ('default' as const)
        }
      : {}),
    serviceTier:
      saved.serviceTier !== undefined
        ? selected.current.serviceTier
        : (options.current.serviceTier ?? selected.current.serviceTier)
  }
  // Unsaved defaults are shown, never sent: the agent's own config decides what an unpicked chat runs.
  const defaultedBy = (key: 'model' | 'effort') =>
    key === 'model' && !options.current.model
      ? displayDefault !== undefined || selected.current.defaulted?.includes(key) === true
      : options.current.defaulted?.includes(key) === true
  const defaulted = (['model', 'effort'] as const).filter(
    (key) => saved[key] === undefined && defaultedBy(key)
  )
  const acceptedInputSources: AgentSessionAcceptedInputSources = {}
  for (const key of ['model', 'effort', 'fastMode', 'serviceTier', 'interactionMode'] as const) {
    if (current[key] !== undefined && saved[key] !== undefined) {
      acceptedInputSources[key] = 'saved'
    }
  }
  if (saved.fastMode === undefined && selected.current.fastMode === false) {
    acceptedInputSources.fastMode = 'policy'
  }
  const confirmed = confirmedCurrentOptions(current, projected ?? options.current)
  if (independent) {
    const { inventory, fallback, listedModelIds } = restingOptions
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
    options = {
      ...options,
      ...view,
      ...(inventory.origin === 'unknown' ? { modelsKnown: false } : {}),
      listedModelIds,
      current
    }
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
    ...recovery,
    forkSupport:
      capabilities?.fork === 'checkpoint'
        ? 'supported'
        : capabilities?.fork === 'tip'
          ? (live?.forkSupport ?? readAcpForkSupport(agent))
          : 'unsupported',
    ...(supportsSessionAccountUsage(record) ? { accountUsage: true as const } : {}),
    ...(live?.effortFixed
      ? {
          models: options.models.map(({ effortsKnown: _unknown, ...row }) => ({
            ...row,
            efforts: []
          }))
        }
      : {}),
    current: {
      ...current,
      acceptedInputSources,
      reportedModel: undefined,
      ...(reportedEffort !== undefined ? { reportedEffort } : {}),
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
    ...(capabilities?.compact && capabilities.compactInstructions
      ? { compactInstructions: true }
      : {}),
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
