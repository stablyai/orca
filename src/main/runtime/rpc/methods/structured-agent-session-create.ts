/**
 * Creating a structured session for a worktree: resolve the create intent, attach it under the
 * host-computed fingerprint, then publish its tab.
 *
 * Extracted from `agentSession.create` so orchestration can start a native-born structured worker
 * on exactly the same path. `activate` is the only knob the two callers differ on: a chat the user
 * asked for takes the surface, a background dispatch must not steal it (the terminal worker path's
 * `surfaceOwner: false`).
 *
 * The prepare/commit split is the pre-commit boundary, not a style choice: nothing before `attach`
 * commits a session, so that span answers with a refusal, and nothing after it may be folded back
 * in. Both callers run the same two halves, so orchestration gets that guarantee too.
 */

import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { StructuredAgentSessionResumeSource } from '../../../../shared/structured-agent-session-create'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  resolveUncommittedStructuredCreate,
  type StructuredCreateRefused
} from './structured-agent-session-precommit-refusal'

export type PreparedStructuredAgentSessionCreate = {
  host: StructuredAgentSessionHost
  attachParams: AgentSessionAttachParams
  /** Null when the caller supplied its own location; only a resolved worktree publishes a tab. */
  tab: { workspaceId: string; agent: 'claude' | 'codex' } | null
}

/** The pre-commit half. Throws; the caller is expected to run it inside
 *  `resolveUncommittedStructuredCreate` so a failure reaches the client as a refusal. */
export async function prepareStructuredAgentSessionCreateForWorktree(args: {
  runtime: OrcaRuntimeService
  /** Installs the host lazily; called at the same point the RPC handler always installed it. */
  ensureHost: () => Promise<StructuredAgentSessionHost>
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: 'claude' | 'codex'
  caller: StructuredAgentSessionCaller
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Replaces the seed options the host resolves from settings. Orchestration passes the
   *  `--model`/`--effort` the dispatch asked for; a chat the user opened passes nothing and keeps
   *  the saved selection. Narrowed by the caller, so `{}` never reaches the reservation. */
  options?: Readonly<Record<string, string>>
}): Promise<PreparedStructuredAgentSessionCreate> {
  // Adoption replay may need the record loaded from disk before source discovery can be skipped.
  let host = args.resumeFrom ? await args.ensureHost() : null
  const resolved = await args.runtime.resolveStructuredAgentSessionCreateIntent({
    envelope: args.envelope,
    worktree: args.worktree,
    agent: args.agent,
    callerKey: args.caller.callerKey,
    ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {})
  })
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: args.envelope.sessionId,
    fields: attachFingerprintFields({ ...resolved, envelope: args.envelope })
  })
  host ??= await args.ensureHost()
  const { agent: _resolvedAgent, provider: _resolvedProvider, ...resolvedAttach } = resolved
  return {
    host,
    attachParams: {
      ...resolvedAttach,
      // After the fingerprint, deliberately: `attachFingerprintFields` excludes options because
      // they are the session's initial state, not its identity, so a retry that re-resolves them
      // must replay rather than conflict.
      ...(args.options ? { options: args.options } : {}),
      provider: resolved.provider as 'claude' | 'codex',
      agent: resolved.agent as 'claude' | 'codex',
      envelope: { ...args.envelope, payloadFingerprint: hostFingerprint }
    },
    tab: {
      workspaceId: resolved.location.workspaceId,
      agent: resolved.agent as 'claude' | 'codex'
    }
  }
}

/** The commit half. Past `attach`, a failure no longer proves the session does not exist. */
export async function commitStructuredAgentSessionCreate(args: {
  runtime: OrcaRuntimeService
  caller: StructuredAgentSessionCaller
  prepared: PreparedStructuredAgentSessionCreate
  activate: boolean
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { prepared } = args
  const result = await prepared.host.attach(args.caller, prepared.attachParams)
  if (!result.ok || !prepared.tab) {
    return result
  }
  try {
    await args.runtime.publishStructuredAgentSessionTab({
      workspaceId: prepared.tab.workspaceId,
      sessionId: result.value.sessionId,
      agent: prepared.tab.agent,
      activate: args.activate
    })
  } catch (error) {
    console.warn('[agent-session] create committed before tab publication failed', error)
    return {
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The chat may have been created, but its tab could not be confirmed.'
      }
    }
  }
  return result
}

export async function createStructuredAgentSessionForWorktree(args: {
  runtime: OrcaRuntimeService
  ensureHost: () => Promise<StructuredAgentSessionHost>
  caller: StructuredAgentSessionCaller
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: 'claude' | 'codex'
  activate: boolean
  options?: Readonly<Record<string, string>>
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const prepared: PreparedStructuredAgentSessionCreate | StructuredCreateRefused =
    await resolveUncommittedStructuredCreate(() =>
      prepareStructuredAgentSessionCreateForWorktree(args)
    )
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  return commitStructuredAgentSessionCreate({
    runtime: args.runtime,
    caller: args.caller,
    prepared,
    activate: args.activate
  })
}
