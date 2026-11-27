import type { z } from 'zod'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'

export type { AcpRelayedProcess }
import { settleAcpSessionCall } from '../protocol/acp-session-call'
import type { AcpPendingCalls } from '../transport/acp-pending-calls'
import {
  PromptResponseSchema,
  type InitializeResponse,
  type PromptResponse
} from '../generated/acp-protocol.generated'
import {
  acpKeptAgent,
  restorableAcpSession,
  type AcpKeptAgent,
  type AcpRelayedProcess
} from './acp-kept-agent'

const SESSION_STARTS = new Set(['session/new', 'session/load', 'session/resume'])
/** How long a send waits for a finished replay's ack before going to the kept agent as it is. */
const REPLAY_SETTLE_WAIT_MS = 3_000
const REPLAY_SETTLE_RETRY_MS = 50

/**
 * An ACP agent kept running under the terminal daemon from before this app started. It is
 * initialized and its session is live, so both are answered from what the daemon kept; a reload
 * would replay history and may replace the live session mid-turn.
 */
export class AcpKeptSession {
  private readonly kept: AcpKeptAgent
  private readonly child: RelayedProviderChild
  private startTaken = false
  private replayWaitSpent = false

  constructor(
    private readonly relayed: AcpRelayedProcess,
    private readonly calls: AcpPendingCalls,
    /** Delivers a kept state update as if the agent had just sent it. */
    private readonly notify: (method: string, params: unknown) => void
  ) {
    const { child } = relayed
    this.child = child
    this.kept = acpKeptAgent(child)
    child.kept.drop()
    calls.startAbove(this.kept.requestFloor)
  }

  /** The agent is initialized already; a second `initialize` is not part of the protocol. Its live
   *  session reopens here even when the agent can't reload sessions, so it says it can. */
  initialize(): Promise<InitializeResponse> {
    const { initialize } = this.kept
    if (!initialize) {
      return Promise.reject(new Error('agent_kept_running_unrestorable'))
    }
    const capabilities = initialize.agentCapabilities
    return Promise.resolve(
      capabilities?.loadSession || capabilities?.sessionCapabilities?.resume
        ? initialize
        : { ...initialize, agentCapabilities: { ...capabilities, loadSession: true } }
    )
  }

  /** Session starts answer from the kept session, once, then its state since; never reaches the
   *  agent (a reload replays history and may replace the live session). Undefined: not a start. */
  answerStart<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    received?: (response: T) => void
  ): Promise<T> | undefined {
    if (!SESSION_STARTS.has(method)) {
      return undefined
    }
    const sessionId =
      typeof params === 'object' && params !== null && 'sessionId' in params
        ? String(params.sessionId)
        : undefined
    const started = this.startTaken ? null : restorableAcpSession(this.kept, sessionId)
    if (!started) {
      return Promise.reject(new Error('agent_kept_running_unrestorable'))
    }
    this.startTaken = true
    try {
      const answer = settleAcpSessionCall(
        method,
        schema,
        undefined,
        received
      )({
        value: started.response
      })
      // Mode, config and commands changed since the start apply before anything new.
      for (const { sessionId: updated, update } of this.kept.updates) {
        if (updated === undefined || updated === started.sessionId) {
          this.notify('session/update', { sessionId: started.sessionId, update })
        }
      }
      return Promise.resolve(answer)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** The agent ended while no app was attached: only its output is left, so nothing is written to it. */
  get agentExited(): boolean {
    return (this.child.exited ?? this.child.attachResult?.exit ?? null) !== null
  }

  /** Reattached for a launch whose app-bound tools it lacks: the next send acquires afresh. */
  get freshOwed(): boolean {
    return this.relayed.freshOwed === true
  }

  /** Acks everything the chat was handed once its reader took it, as a hand-off does, within a
   *  bound: a stalled stdin write or reader leaves the replay unacked rather than holding a send. */
  async replaySettled(): Promise<void> {
    // One that ran out of time once doesn't hold later sends again; acks still land on their own.
    if (this.replayWaitSpent) {
      return
    }
    // The replay reaches the reader in slices: ack each part handed on until the attach's whole
    // replay is acked, or the bound runs out.
    const until = Date.now() + REPLAY_SETTLE_WAIT_MS
    while (!this.child.replayAcked() && Date.now() < until) {
      const left = until - Date.now()
      await withTimeout(
        this.child.settle(true, left).catch(() => undefined),
        left,
        undefined
      )
      if (!this.child.replayAcked() && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, REPLAY_SETTLE_RETRY_MS))
      }
    }
    this.replayWaitSpent = !this.child.replayAcked()
  }

  /** See `StructuredAgentSessionAdapter.keptLaunchOutgrown`: false until the replay is acked. */
  get launchOutgrown(): boolean | undefined {
    if (!this.child.replayAcked()) {
      return false
    }
    return this.freshOwed || undefined
  }

  /** The earlier app's prompt is still owed, or answered in the held replay. */
  get owesPrompt(): boolean {
    return this.kept.earlierPromptId !== null
  }

  /** Names this replay's start: the daemon's cut, else the cursor, which the adopted prompt's floor
   *  holds until it is answered, so every attach in that prompt renumbers its messages alike. */
  get replayKey(): string {
    return `${this.child.relayId}:${this.child.attachResult?.truncatedThrough ?? this.child.attachedFrom}`
  }

  /** The replay holds that prompt's every line, so its messages are numbered as the live run did. */
  get promptReplayedWhole(): boolean {
    return this.kept.earlierPromptWhole
  }

  /** The answer to the earlier app's prompt, by its id; none listed means it never reached the
   *  agent (the earlier app quit before writing it), so its turn fails instead of hanging. */
  earlierPrompt(): Promise<PromptResponse> {
    const id = this.kept.earlierPromptId
    if (id === null) {
      return Promise.reject(new Error('The message did not reach the agent before Orca restarted'))
    }
    const settle = settleAcpSessionCall('session/prompt', PromptResponseSchema, undefined)
    return this.relayed.turns.track((onId) => {
      onId(id)
      return this.calls.adoptEarlier(id, 'session/prompt', settle)
    }, true)
  }

  /** Background work the daemon still counted open at this attach, or saw end while no app was
   *  attached (`ended`), by its first key part. */
  openWork(group: string, ended = false): string[] {
    const work = ended ? this.child.attachResult?.endedWork : this.child.attachResult?.openWork
    return (work?.[group] ?? []).flatMap((key) => key[0] ?? [])
  }

  /** Lets the held output through once the chat can route it. */
  releaseOutput(): void {
    this.child.releaseOutput()
  }
}

export function keptAcpSession(
  relayed: AcpRelayedProcess | undefined,
  calls: AcpPendingCalls,
  notify: (method: string, params: unknown) => void
): AcpKeptSession | null {
  return relayed?.reattached ? new AcpKeptSession(relayed, calls, notify) : null
}
