import { effectiveAgentSessionOptions } from '../../../shared/agent-session-default-model'
import {
  refuse,
  type AgentSessionOptionResult,
  type AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Passive verified configuration reads never launch a probe or substitute the current model. */
export async function readStructuredAgentSessionDefaultModel(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  sessionId: string
): Promise<AgentSessionOptionsResult['defaultModel']> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    return undefined
  }
  const listing = await deps.modelCatalog
    ?.read({
      agent: record.provider,
      sessionId,
      inSessionWorkspace: true,
      savedOnly: true,
      verifiedOnly: true,
      requireConfiguredDefault: true
    })
    .catch(() => null)
  const catalog =
    listing && listing.origin !== 'unknown' && !listing.listingInProgress && !listing.unavailable
      ? listing
      : undefined
  const id =
    record.defaultModelOptions !== undefined
      ? record.defaultModelOptions.model
      : (catalog?.defaultModelOptions?.model ??
        (catalog?.listingNamesConfiguredModel === true
          ? catalog.models.find((model) => model.isDefault)?.id
          : undefined))
  if (!id) {
    return undefined
  }
  const model = catalog?.models.find((model) => model.id === id)
  return {
    id,
    label: model?.label ?? id,
    ...(model?.description ? { description: model.description } : {})
  }
}

/** Read original host configuration, never a resumed thread's current model or a recommendation. */
export async function resetStructuredAgentSessionModel(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'fence' | 'now' | 'publish' | 'journal'>,
  hasProviderChild: boolean,
  key: string
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  if (key !== 'model') {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        'Only model can reset to Default'
      )
    }
  }
  const record = deps.store.getRecord(ctx.sessionId)
  const listing =
    record &&
    (await deps.modelCatalog
      ?.read({
        agent: record.provider,
        sessionId: ctx.sessionId,
        inSessionWorkspace: true,
        verifiedOnly: true,
        requireConfiguredDefault: true,
        waitForListing: true
      })
      .catch(() => null))
  const baseline =
    listing?.origin !== 'unknown' && listing?.listingNamesConfiguredModel === true
      ? listing.models.find((model) => model.isDefault)
      : undefined
  const configured =
    listing && listing.origin !== 'unknown' ? listing.defaultModelOptions : undefined
  if (
    !record ||
    (!configured && !baseline && (hasProviderChild || ctx.journal.submissions().length > 0))
  ) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        "The host has not reported this workspace's original default model. Start a new chat to use the provider default."
      )
    }
  }
  const defaultModelOptions: Record<string, string> =
    configured ?? (baseline ? { model: baseline.id } : {})
  const options = Object.fromEntries(
    Object.entries(record.options ?? {}).filter(([key]) => key !== 'model')
  )
  const updated = await deps.store.replaceSessionOptions({
    sessionId: ctx.sessionId,
    fence: ctx.fence,
    now: ctx.now(),
    options,
    defaultModelOptions
  })
  ctx.publish()
  return {
    ok: true,
    value: {
      key: 'model',
      value: null,
      modelDefault: true,
      options: effectiveAgentSessionOptions(updated) ?? {}
    }
  }
}
