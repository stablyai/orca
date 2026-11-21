import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { effectiveAgentSessionOptions } from '../../../runtime/agent-session/records/agent-session-record-options'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type {
  AgentSessionTurnContext,
  TurnOutcome
} from '../operations/structured-agent-session-turns'

type ModelDefaultDeps = Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>

/** A listing's recommended model is not the agent's configured one, so only a verified naming counts. */
async function configuredDefaultModel(
  deps: ModelDefaultDeps,
  record: AgentSessionRecord
): Promise<Record<string, string> | undefined> {
  const listing = await deps.modelCatalog
    ?.read({
      agent: record.provider,
      sessionId: record.sessionId,
      inSessionWorkspace: true,
      verifiedOnly: true,
      requireConfiguredDefault: true,
      waitForListing: true
    })
    .catch(() => null)
  if (!listing || listing.origin === 'unknown') {
    return undefined
  }
  // The host's configuration evidence names a model the listing may lack, and its effort.
  const named = listing.listingNamesConfiguredModel
    ? listing.models.find((model) => model.isDefault)?.id
    : undefined
  return listing.defaultModelOptions ?? (named ? { model: named } : undefined)
}

/** Default keeps the configured model the host names, so a later config change can't move the chat;
 *  only a chat that never ran may launch without one. */
export async function resetStructuredAgentSessionModel(
  deps: ModelDefaultDeps,
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'fence' | 'now' | 'publish' | 'journal'>,
  hasProviderChild: boolean
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const record = deps.store.getRecord(ctx.sessionId)
  const configured = record ? await configuredDefaultModel(deps, record) : undefined
  // A provider thread may keep its own model, so only a chat with none launches on the default.
  const unstarted =
    !configured &&
    !hasProviderChild &&
    record?.providerHandleChain.length === 0 &&
    (await ctx.journal.reads.savedContent()) === 'empty'
  if (!record || (!configured && !unstarted)) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        "The host can't name this agent's default model for a chat that already ran."
      )
    }
  }
  const { model: _override, ...options } = record.options ?? {}
  const updated = await deps.store.replaceSessionOptions({
    sessionId: ctx.sessionId,
    fence: ctx.fence,
    now: ctx.now(),
    options,
    defaultModelOptions: configured ?? {}
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
