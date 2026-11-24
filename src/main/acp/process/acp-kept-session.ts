import type { z } from 'zod'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import type { RelayedProviderProcess } from '../../provider-relay/app-provider-relays'
import { settleAcpSessionCall } from '../protocol/acp-session-call'
import type { AcpPendingCalls } from '../transport/acp-pending-calls'
import {
  PromptResponseSchema,
  type InitializeResponse,
  type PromptResponse
} from '../generated/acp-protocol.generated'
import { acpKeptAgent, restorableAcpSession, type AcpKeptAgent } from './acp-kept-agent'

const SESSION_STARTS = new Set(['session/new', 'session/load', 'session/resume'])

/**
 * An ACP agent kept running under the terminal daemon from before this app started. It is
 * initialized and its session is live, so both are answered from what the daemon kept; a reload
 * would replay history and may replace the live session mid-turn.
 */
export class AcpKeptSession {
  private readonly kept: AcpKeptAgent
  private startTaken = false

  constructor(
    private readonly child: RelayedProviderChild,
    private readonly calls: AcpPendingCalls,
    /** Delivers a kept state update as if the agent had just sent it. */
    private readonly notify: (method: string, params: unknown) => void
  ) {
    this.kept = acpKeptAgent(child)
    child.dropKeptLines()
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

  /** The earlier app's prompt is still owed, or answered in the held replay. */
  get owesPrompt(): boolean {
    return this.kept.earlierPromptId !== null
  }

  /** The replay holds that prompt's every line, so its messages are numbered as the live run did. */
  get promptReplayedWhole(): boolean {
    return this.kept.earlierPromptWhole
  }

  /** The answer to the earlier app's prompt, by its id; none listed means it never reached the
   *  agent (the earlier app quit before writing it), so its turn fails instead of hanging. */
  earlierPrompt(): Promise<PromptResponse> {
    const id = this.kept.earlierPromptId
    return id === null
      ? Promise.reject(new Error('The message did not reach the agent before Orca restarted'))
      : this.calls.adoptEarlier(
          id,
          'session/prompt',
          settleAcpSessionCall('session/prompt', PromptResponseSchema, undefined)
        )
  }

  /** Background work the daemon still counted open at this attach, by its first key part. */
  openWork(group: string): string[] {
    return (this.child.attachResult?.openWork?.[group] ?? []).flatMap((key) => key[0] ?? [])
  }

  /** Lets the held output through once the chat can route it. */
  releaseOutput(): void {
    this.child.releaseOutput()
  }
}

export function keptAcpSession(
  relayed: RelayedProviderProcess | undefined,
  calls: AcpPendingCalls,
  notify: (method: string, params: unknown) => void
): AcpKeptSession | null {
  return relayed?.reattached ? new AcpKeptSession(relayed.child, calls, notify) : null
}
