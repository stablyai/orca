/**
 * Starting and retiring a worker that IS a structured agent session.
 *
 * Three things make this different from the PTY worker path, and all three live here:
 *
 * - The session is created directly as structured, so readiness is the attach returning ok. There
 *   is no boot-to-idle gap to wait on and no `tui-idle` edge to read.
 * - Nothing here keeps its agent running. The idle sweep leaves it running while its dispatch is
 *   open, reading that from the orchestration database; once the dispatch settles the agent rests
 *   like any chat's, and the next mail starts it.
 * - The dispatch preamble is a turn, not keystrokes.
 */

import { randomUUID } from 'node:crypto'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../../shared/agent-session-definitive-refusal'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../../shared/orchestration-timing-budgets'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  mintAgentSessionOperationId,
  structuredPointerPayloadFingerprint
} from '../../orchestration/structured-pointer-operation-id'
import { structuredPointerCallerKey } from '../../orchestration/structured-mailbox-pointer-host'
import { retireSettledStructuredWorkerTab } from '../../structured-agent-session-tab-retirement'
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

/**
 * Drops the dispatch's redrive subscription, its registry entry and its parked mail.
 *
 * EVERY settlement has to reach this — stop, release AND abandon. A surviving subscription keeps
 * nudging a session no dispatch owns.
 */
export function releaseStructuredWorkerSession(
  dispatchId: string,
  runtime?: Pick<OrcaRuntimeService, 'forgetStructuredSessionMail'>
): void {
  const binding = bindingsByDispatchId.get(dispatchId)
  if (!binding) {
    return
  }
  bindingsByDispatchId.delete(dispatchId)
  binding.disposeSubscription()
  structuredWorkerIdentities.forget(binding.handle)
  runtime?.forgetStructuredSessionMail?.(binding.sessionId)
}

export async function createStructuredWorkerSession(args: {
  runtime: OrcaRuntimeService
  worktreeId: string
  agent: 'claude' | 'codex'
  dispatchId: string
  /** The dispatch's own `--model`/`--effort`, already narrowed to the seedable string subset. */
  options?: Readonly<Record<string, string>>
  /** Retried whenever the session's journal moves, which is the structured idle edge. */
  onJournalActivity: (sessionId: string) => void
}): Promise<{ identity: StructuredWorkerIdentity; host: StructuredAgentSessionHost }> {
  const sessionId = randomUUID()
  // Registered BEFORE the session is created, because `attach` is what spawns the provider child
  // and the child's environment is read from this registry at spawn time. Registering afterwards
  // ships a worker with no ORCA_TERMINAL_HANDLE, whose bare `orca orchestration check` then
  // resolves to whatever single leaf sits in the worktree — by default the COORDINATOR's pane.
  //
  // The scope is provisionally local; the record's own location is asserted local below, and a
  // session that resolves anywhere else is discarded.
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
        // Empty on purpose: `prepare` overwrites this with the host's own attach fingerprint, and
        // the create-intent conflict check it would otherwise feed guards the RPC boundary against
        // a replayed operation id — there is no such boundary on this in-process call.
        payloadFingerprint: ''
      },
      worktree: `id:${args.worktreeId}`,
      agent: args.agent,
      // Absent, the host seeds the user's saved selection — the same fallback a chat gets.
      ...(args.options ? { options: args.options } : {}),
      // Dispatching a worker is background work; it must not pull the surface away from the user.
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
    return { identity, host }
  } catch (error) {
    // A start that fails after the session exists would otherwise strand a live provider child
    // that no dispatch owns and that nothing else in the runtime will ever retire.
    structuredWorkerIdentities.forget(identity.handle)
    if (structuredCreateMayHaveCommitted(created)) {
      await discardStructuredWorkerSession(sessionId, args.runtime)
    }
    throw error
  }
}

/**
 * Whether a create may have attached a session, which is the question cleanup has to ask.
 *
 * `ok` is not the test. `commit` answers `agent_session_operation_unknown` when `attach` SUCCEEDED
 * and only the tab publish failed, and a throw out of the commit half is past `attach` too — the
 * pre-commit half never throws, it refuses. Both leave a session with a published tab and no
 * binding, so nothing else in the runtime will ever retire it. Only a DEFINITIVE refusal
 * proves there is nothing to discard; everything else gets the best-effort close.
 */
function structuredCreateMayHaveCommitted(
  created: Awaited<ReturnType<typeof createStructuredAgentSessionForWorktree>> | undefined
): boolean {
  return !created || created.ok || !isDefinitiveAgentSessionCreateRefusal(created.refusal.code)
}

/**
 * Best-effort teardown of a session created by a worker start that then failed.
 *
 * Stops the provider child, drops the DURABLE tab reference so nothing restores the chat after a
 * restart, and — only once the close came back without throwing — retires the background tab this
 * start published from the live snapshot. All three are no-ops for a session that was never
 * attached, which is why a non-definitive refusal can reach here unconditionally. A close that
 * threw leaves the tab alone: the child may still be running, and the tab is the way to reach it.
 *
 * Exported because a start can also fail AFTER `createStructuredWorkerSession` returned — on the
 * authority gate, or on the preamble turn — and that is the fourth settlement path. Dropping only
 * the hold there left one dead "Claude Chat"/"Codex Chat" tab per failed start, durably restored
 * on every subsequent app launch.
 */
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
    await host.close(sessionId)
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

/** What a preamble send reads of the host. */
type StructuredWorkerPreambleHost = Pick<
  StructuredAgentSessionHost,
  'send' | 'waitForSendSettlement'
> & {
  deps: { store: { getRecord: (sessionId: string) => { lease: { runtimeFence: number } } | null } }
}

/** Delivers the dispatch preamble as the worker's first turn. `pending`: the worker's agent had
 *  not taken it within the wait; the host still holds it for that agent, and never re-sends it. */
export async function sendStructuredWorkerPreamble(args: {
  host: StructuredWorkerPreambleHost
  sessionId: string
  dispatchId: string
  preamble: string
}): Promise<'accepted' | 'pending'> {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: args.preamble }]
  }
  const fence = args.host.deps.store.getRecord(args.sessionId)?.lease.runtimeFence
  if (fence === undefined) {
    throw new Error('The structured worker session has no durable record to dispatch into.')
  }
  const result = await args.host.send(
    { callerKey: structuredPointerCallerKey(args.dispatchId) },
    {
      envelope: {
        sessionId: args.sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredPointerPayloadFingerprint(args.sessionId, body)
      },
      body
    }
  )
  if (!result.ok) {
    throw new Error(`The dispatch preamble was refused: ${result.refusal.message}`)
  }
  // Accepted is not delivered: the worker's agent may still be starting.
  const submission =
    result.value.submission.dispatchState === 'pending'
      ? ((
          await args.host
            .waitForSendSettlement(args.sessionId, result.value.clientMessageId, {
              budgetMs: ORCHESTRATION_READINESS_TIMEOUT_MS
            })
            .catch(() => undefined)
        )?.value.submission ?? result.value.submission)
      : result.value.submission
  if (submission.dispatchState === 'accepted' || submission.dispatchState === 'pending') {
    return submission.dispatchState
  }
  if (submission.dispatchState === 'rejected') {
    // A rejection is a verdict, not a mystery: the preamble provably did not happen.
    // `dispatch_preamble_undelivered` says exactly that, and says it as a code rather
    // than as prose, so a coordinator can tell "we could not send it" apart from
    // `operation_unknown`'s "it may be running and you must go look". Both discard the
    // pending receipt; only this one lets the caller retry knowing nothing landed.
    throw new OrchestrationError(
      'dispatch_preamble_undelivered',
      `The dispatch preamble was not delivered: ${submission.reason ?? 'no reason given'}.`
    )
  }
  // Only `accepted` is an acknowledgement — the same rule the mail lane already applies. A thrown
  // adapter call settles as `unknown`, which is indistinguishable from a lost reply, so the start
  // may claim neither delivery nor failure: `operation_unknown` is what turns this into the
  // `outcome_unknown` receipt whose nextCommands send the coordinator to look.
  throw new OrchestrationError(
    'operation_unknown',
    `The dispatch preamble was submitted but not acknowledged (${submission.dispatchState}): ${submission.reason ?? 'no reason given'}.`
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

/**
 * Quiet window before a coalesced redrive runs. A settled turn stops emitting, so this is how long
 * after the last batch the nudge lands — short enough to read as immediate, long enough that a
 * streaming turn collapses into a handful of evaluations instead of one per batch.
 */
const REDRIVE_FLUSH_MS = 300

/** A turn that streams without pause still gets re-evaluated this often. */
const REDRIVE_MAX_WAIT_MS = 2_000

/**
 * Any journal movement is the redrive edge, coalesced.
 *
 * A settled turn is TOMBSTONED rather than rewritten, so watching for a completed lifecycle row
 * would miss the common case — every batch has to be a candidate. Running the gate on each one is
 * not free once mail IS parked on the session: the edge re-resolves the dispatch, queries unread
 * mail and reads the host's gate facts, only to re-park because the turn is still running. A
 * streaming turn paid that per batch.
 *
 * Coalescing costs nothing in delivery terms. The pointer body names only HOW MANY messages are
 * waiting, so the edge is inherently batch-shaped, and this is not the path fresh mail takes to an
 * idle worker — that is `deliverForHandle`, called when the message is enqueued and untouched
 * here. This is only the retry for mail already parked because the worker was busy.
 */
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
    // Disposal drops the pending timer rather than flushing it: every settlement reaches here, and
    // a redrive that fires after it would nudge a session no dispatch owns.
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
