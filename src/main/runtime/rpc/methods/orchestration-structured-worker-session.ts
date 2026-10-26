/** Create structured workers directly; attach is not readiness, so hold the preamble until the agent takes it.
 * Open dispatches retain agents through the idle sweep; settled workers rest and restart on mail. The preamble is a turn, never keystrokes. */

import { randomUUID } from 'node:crypto'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../../shared/agent-session-definitive-refusal'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { mintAgentSessionOperationId } from '../../orchestration/structured-pointer-operation-id'
import { structuredPointerCallerKey } from '../../orchestration/structured-mailbox-pointer-host'
import { sendAgentTurn, type StructuredAgentTurnHost } from '../../orchestration/send-agent-turn'
import { retireSettledStructuredWorkerTab } from '../../agent-session/structured-agent-session-tab-retirement'
import { structuredWorkerSession } from '../../structured-worker-authority'
import {
  mintStructuredWorkerHandle,
  structuredWorkerHostScope,
  structuredWorkerIdentities,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation,
  type StructuredWorkerIdentity
} from '../../structured-worker-identity'
import { createKeyedTrailingEdgeCoalescer } from '../../keyed-trailing-edge-coalescer'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'

type StructuredWorkerBinding = {
  sessionId: string
  handle: string
  disposeSubscription: () => void
}

const bindingsByDispatchId = new Map<string, StructuredWorkerBinding>()

/** Every stop/release/abandon must drop redrive, identity and parked mail across the worker's /clear lineage, even after restart lost its binding. */
export function releaseStructuredWorkerSession(
  dispatchId: string,
  runtime?: Pick<OrcaRuntimeService, 'forgetStructuredSessionMail'>,
  workerSessionId?: string | null
): void {
  const binding = bindingsByDispatchId.get(dispatchId)
  if (binding) {
    bindingsByDispatchId.delete(dispatchId)
    binding.disposeSubscription()
    structuredWorkerIdentities.forget(binding.handle)
  }
  const rootSessionId = binding?.sessionId ?? workerSessionId
  if (!rootSessionId || !runtime?.forgetStructuredSessionMail) {
    return
  }
  for (const sessionId of structuredWorkerSession({ sessionId: rootSessionId }).lineage) {
    runtime.forgetStructuredSessionMail(sessionId)
  }
}

export async function createStructuredWorkerSession(args: {
  runtime: OrcaRuntimeService
  worktreeId: string
  agent: TuiAgent
  dispatchId: string
  /** The dispatch's own `--model`/`--effort`, already narrowed to the seedable string subset. */
  options?: Readonly<Record<string, string>>
  /** Retried whenever the session's journal moves, which is the structured idle edge. */
  onJournalActivity: (sessionId: string) => void
}): Promise<{
  identity: StructuredWorkerIdentity
  host: StructuredAgentSessionHost
  /** The lease the create was admitted at. */
  fence: number
}> {
  const sessionId = randomUUID()
  // Register before attach builds child env or missing ORCA_TERMINAL_HANDLE can misroute orchestration to the coordinator.
  // Assert the provisional local scope against the created record; discard non-local sessions.
  const identity = structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId,
    agent: args.agent,
    paneKey: mintStructuredWorkerPaneKey(sessionId),
    processIncarnation: structuredWorkerProcessIncarnation(sessionId),
    worktreeId: args.worktreeId,
    hostScope: { kind: 'local', hostId: 'local' }
  })
  let created: Awaited<ReturnType<typeof createStructuredAgentSessionForWorktree>> | undefined
  try {
    created = await createStructuredAgentSessionForWorktree({
      runtime: args.runtime,
      ensureHost: async () => {
        await args.runtime.ensureStructuredAgentSessionHost()
        return requireInstalledHost()
      },
      caller: { callerKey: structuredPointerCallerKey(args.dispatchId) },
      envelope: {
        sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: null,
        // prepare supplies the host attach fingerprint; this in-process id has no replayed RPC create intent.
        payloadFingerprint: ''
      },
      worktree: `id:${args.worktreeId}`,
      agent: args.agent,
      // Absent, the host seeds the user's saved selection — the same fallback a chat gets.
      ...(args.options ? { options: args.options } : {}),
      // Dispatching a worker is background work; it must not pull the surface away from the user.
      atRest: true,
      activate: false
    })
    if (!created.ok) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `The structured ${args.agent} session for this worker was refused: ${created.refusal.message}`
      )
    }
    const host = requireInstalledHost()
    const record = host.deps.store.getRecord(sessionId)
    if (!record || !structuredWorkerHostScope(record.location)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        'A structured worker must run on the local execution host outside WSL.'
      )
    }
    const disposeSubscription = await subscribeForRedrive(host, sessionId, args.onJournalActivity)
    bindingsByDispatchId.set(args.dispatchId, {
      sessionId,
      handle: identity.handle,
      disposeSubscription
    })
    return { identity, host, fence: created.value.fence }
  } catch (error) {
    // Failed post-create starts must retire the otherwise unowned live provider child.
    structuredWorkerIdentities.forget(identity.handle)
    if (structuredCreateMayHaveCommitted(created)) {
      await discardStructuredWorkerSession(sessionId, args.runtime)
    }
    throw error
  }
}

/** Only definitive refusal proves no session exists. Unknown/throws after attach may leave a live child and tab, so attempt cleanup. */
function structuredCreateMayHaveCommitted(
  created: Awaited<ReturnType<typeof createStructuredAgentSessionForWorktree>> | undefined
): boolean {
  return !created || created.ok || !isDefinitiveAgentSessionCreateRefusal(created.refusal.code)
}

/** Failed starts close the child, hide its durable tab, then retire its live tab only after successful close.
 * Keep the tab reachable if close throws. Later authority/preamble failures also use this cleanup. */
export async function discardStructuredWorkerSession(
  sessionId: string,
  runtime: Pick<OrcaRuntimeService, 'retireStructuredAgentSessionTabFromSnapshot'>
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  try {
    await host.setSessionTabVisibility?.(sessionId, false)
    await host.close(sessionId, 'evict')
  } catch (error) {
    console.warn(
      '[orchestration] failed to discard a half-started structured worker',
      sessionId,
      error
    )
    return
  }
  retireSettledStructuredWorkerTab(sessionId, runtime)
}

/** A submission reason as a clause: host sentences end in a period, legacy markers do not. */
function reasonClause(reason: string | null | undefined): string {
  return (reason ?? 'no reason given').replace(/[.\s]+$/, '')
}

/** What a preamble send reads of the host. */
type StructuredWorkerPreambleHost = StructuredAgentTurnHost & {
  deps: { store: { getRecord: (sessionId: string) => { lease: { runtimeFence: number } } | null } }
}

/** Delivers the dispatch preamble as the worker's first turn. `pending`: the worker's agent had
 *  not taken it within the wait; the host still holds it for that agent, and never re-sends it. */
export async function sendStructuredWorkerPreamble(args: {
  host: StructuredWorkerPreambleHost
  sessionId: string
  dispatchId: string
  preamble: string
  /** Who the task is from (`dispatchTaskSource`), shown on the worker's turn. */
  from: AgentMessageSource
  /** The worker start's readiness budget, which the agent's start counts against. */
  budgetMs?: number
}): Promise<'accepted' | 'pending'> {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: args.preamble }],
    from: args.from
  }
  const fence = args.host.deps.store.getRecord(args.sessionId)?.lease.runtimeFence
  if (fence === undefined) {
    throw new Error('The structured worker session has no durable record to dispatch into.')
  }
  const outcome = await sendAgentTurn({
    kind: 'structured-session',
    host: args.host,
    sessionId: args.sessionId,
    callerKey: structuredPointerCallerKey(args.dispatchId),
    ...(args.budgetMs === undefined ? {} : { budgetMs: args.budgetMs }),
    turn: {
      body,
      delivery: 'now',
      operationId: mintAgentSessionOperationId(Date.now()),
      expectedRuntimeFence: fence
    }
  })
  switch (outcome.kind) {
    case 'refused':
      throw new Error(`The dispatch preamble was refused: ${outcome.refusal.message}`)
    case 'queued':
      // Never for a `now` send; a held draft proves nothing about the worker taking it.
      return preambleDispatchState(undefined)
    case 'sent':
      return preambleDispatchState(outcome.submission)
  }
}

/** A sent preamble's verdict: acknowledged, or held for its agent; anything else throws. */
export function preambleDispatchState(
  submission: AgentJournalSubmission | undefined
): 'accepted' | 'pending' {
  if (submission?.dispatchState === 'accepted' || submission?.dispatchState === 'pending') {
    return submission.dispatchState
  }
  if (submission?.dispatchState === 'rejected') {
    // Definitive rejection gets a typed non-delivery code so the coordinator can retry without a duplicate turn.
    throw new OrchestrationError(
      'dispatch_preamble_undelivered',
      `The dispatch preamble was not delivered${
        submission.rejection ? ` (${submission.rejection.kind})` : ''
      }: ${reasonClause(submission.reason)}.`
    )
  }
  // Only accepted proves delivery; adapter/transport unknown requires an outcome_unknown receipt that tells the coordinator to inspect.
  throw new OrchestrationError(
    'operation_unknown',
    `The dispatch preamble was submitted but not acknowledged (${submission?.dispatchState ?? 'unknown'}): ${reasonClause(submission?.reason)}.`
  )
}

function requireInstalledHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'Structured agent sessions are unavailable on this runtime.'
    )
  }
  return host
}

/** Coalesce streaming batches until quiet; settled turns stop emitting, so the final nudge still lands promptly. */
const REDRIVE_FLUSH_MS = 300

/** A turn that streams without pause still gets re-evaluated this often. */
const REDRIVE_MAX_WAIT_MS = 2_000

/** Any journal batch can carry a tombstoned turn settlement; coalesce expensive parked-mail gate checks.
 * Pointers count waiting messages, so batches may combine safely. Fresh mail still uses deliverForHandle immediately. */
async function subscribeForRedrive(
  host: StructuredAgentSessionHost,
  sessionId: string,
  onJournalActivity: (sessionId: string) => void
): Promise<() => void> {
  const coalescer = createKeyedTrailingEdgeCoalescer(onJournalActivity, {
    flushMs: REDRIVE_FLUSH_MS,
    maxWaitMs: REDRIVE_MAX_WAIT_MS
  })
  try {
    const unsubscribe = await host.subscribe({
      id: `orchestration:redrive:${sessionId}`,
      sessionId,
      emit: (event) => {
        if (event.type === 'batch' || event.type === 'reset') {
          coalescer.schedule(sessionId)
        }
      }
    })
    // Discard pending redrive on settlement so it cannot nudge a session no dispatch owns.
    return () => {
      coalescer.dispose()
      unsubscribe()
    }
  } catch (error) {
    console.warn('[orchestration] structured worker redrive subscription failed', sessionId, error)
    coalescer.dispose()
    return () => {}
  }
}
