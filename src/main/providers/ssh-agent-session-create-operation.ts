import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION } from '../../shared/agent-session-host-authority'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtySpawnResult } from './pty-spawn-result'

export const SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS = 5_000

export function assertSshAgentSessionCreateResult(
  result: unknown
): asserts result is PtySpawnResult {
  const candidate = result as Partial<PtySpawnResult> | null
  if (
    typeof candidate?.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 512 &&
    isPtyIncarnationId(candidate.incarnationId)
  ) {
    return
  }
  // Why: a malformed success arrived after dispatch, so retain the replay fence instead of
  // falling back or issuing a fresh operation that could duplicate a live PTY.
  throw Object.assign(new Error('execution_owner_unavailable'), {
    agentSessionOperationOutcome: 'unknown' as const
  })
}

export async function sshSupportsAgentSessionCreateOperations(
  mux: SshChannelMultiplexer,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  try {
    const result = (await mux.request('pty.getCapabilities', undefined, {
      signal: options.signal,
      timeoutMs: SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS
    })) as {
      agentSessionCreateOperationVersion?: unknown
    }
    return (
      result.agentSessionCreateOperationVersion === AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    )
  } catch {
    // Why: capability probing does not spawn, so an old relay can safely keep legacy behavior.
    return false
  }
}

export async function requestSshAgentSessionCreate(args: {
  mux: SshChannelMultiplexer
  params: Record<string, unknown>
  operationId?: string
  signal?: AbortSignal
}): Promise<unknown> {
  try {
    return await (args.signal
      ? args.mux.request('pty.spawn', args.params, { signal: args.signal })
      : args.mux.request('pty.spawn', args.params))
  } catch (error) {
    if (!args.operationId) {
      throw error
    }
    const spawnError = error instanceof Error ? error : new Error(String(error))
    // Why: after request dispatch, either an old relay or a capable replay ledger may own a PTY.
    throw Object.assign(spawnError, { agentSessionOperationOutcome: 'unknown' as const })
  }
}
