// A chat's options, live or at rest.
//
// At rest nothing here needs a child. The pick is the record's own `options` — what the next start replays —
// and the list is the host's model catalog, the same one the picker already reads before a chat
// exists. A pick made at rest is written to the record as intent, through the same transition a live
// pick takes, so the next start applies it.

import {
  refuse,
  type AgentSessionModelOption,
  type AgentSessionOptionResult,
  type AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { claudeFallbackModelOptions } from '../../claude/claude-structured-session-options'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import { isClaudeStructuredOptionKey } from '../../claude/claude-structured-options'
import { isCodexTurnOptionKey } from '../../codex/codex-structured-turn-start'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { structuredAgentSessionOptionModels } from './structured-agent-session-option-models'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

type RestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'fastModeSupport' | 'current' | 'conversationCommands'
>

/** With no catalog for the account, the list a running child falls back to: Claude's built-in
 *  models. A Codex child has no such list, so none: the client fills the current model from its
 *  own unknown-model defaults, unchanged from before this list was shared. */
function restingFallbackModels(
  provider: AgentSessionRecord['provider']
): AgentSessionModelOption[] | null {
  return provider === 'claude' ? claudeFallbackModelOptions() : null
}

async function readStructuredAgentSessionOptionsAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  sessionId: string
): Promise<RestingOptions> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const catalog = (record.provider === 'dsh-acp'
    ? undefined
    : await deps.modelCatalog?.read({ agent: record.provider, sessionId }).catch(() => null)) ?? {
    origin: 'unknown' as const
  }
  const listed =
    catalog.origin === 'unknown' ? restingFallbackModels(record.provider) : catalog.models
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
    (catalog.origin === 'unknown' ? undefined : models.find((entry) => entry.isDefault)?.id) ??
    ''
  // As a live child answers: the pick, else what Claude runs for this model when none is sent.
  // A live Codex child answers only the effort its thread reported, never the model's default.
  const effort =
    saved.effort ??
    (record.provider === 'claude'
      ? models.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  return {
    ...(record.provider === 'dsh-acp' ? { conversationCommands: ['clear'] as const } : {}),
    models: listed ? structuredAgentSessionOptionModels(listed, model, (row) => row) : [],
    ...(catalog.origin !== 'unknown' && catalog.fastModeSupport
      ? { fastModeSupport: catalog.fastModeSupport }
      : {}),
    current: {
      model,
      ...(effort ? { effort } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {})
    }
  }
}

/** Records a pick for the next start. Only a key the provider would accept is kept. */
export async function recordStructuredAgentSessionOptionIntent(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'persistOptions' | 'publish'>,
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const record = store.getRecord(ctx.sessionId)
  const accepted =
    record?.provider === 'codex'
      ? isCodexTurnOptionKey(input.key)
      : record?.provider === 'claude' && isClaudeStructuredOptionKey(input.key)
  if (!record || !accepted) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        `${record?.provider ?? 'This session'} has no session option named ${input.key}`
      )
    }
  }
  const options = { ...record.options, [input.key]: input.value }
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
  const { adapter, store } = context.deps
  const live = await context.serialize(sessionId, async () => {
    const session = await context.openConversation(sessionId).catch((error: unknown) => {
      throw journalOpenReadRefusal(error, context.deps.logger, sessionId)
    })
    const child = session?.child
    if (!child) {
      return null
    }
    if (!adapter.readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    return adapter.readOptions({ sessionId, fence: child.fence })
  })
  const options = live ?? (await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId))
  // Re-acquired after the reads above: the handle they saw may have closed and reopened since.
  const session = await context.conversation(sessionId)
  const phase = store.getRecord(sessionId)?.rewind?.phase
  const agent = session.params.provider
  return {
    ...options,
    rewind:
      phase === 'prepared' || phase === 'provider-succeeded'
        ? { supported: false, reason: 'outcome-unknown' }
        : (adapter.rewindSupport?.(sessionId, agent) ?? {
            supported: false,
            reason: 'unsupported'
          }),
    conversationCommands:
      options.conversationCommands ?? (adapter.compact ? ['clear', 'compact'] : ['clear']),
    ...(adapter.supportsThreadGoal?.(sessionId, agent)
      ? { threadGoal: { current: session.journal.threadGoal() } }
      : {}),
    ...(adapter.recordsContextUsage?.(sessionId, agent)
      ? { contextUsage: { current: session.journal.contextUsage() } }
      : {})
  }
}
