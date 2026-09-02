import {
  AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION,
  isAgentSessionClaimedSpawnResult,
  type AgentSessionExecutionClaim,
  type AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { PtySpawnResult } from './pty-spawn-result'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from './ssh-agent-session-create-operation'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'

export type ClaimedSshSpawnValidation =
  | { valid: true }
  | { valid: false; cleanup: 'created' | 'none'; error: string }

export async function proveSshAgentSessionClaimCapability(
  mux: SshChannelMultiplexer,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  try {
    const result = (await mux.request('pty.getCapabilities', undefined, {
      signal: options.signal,
      timeoutMs: SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS
    })) as {
      agentSessionClaimVersion?: unknown
    }
    if (result.agentSessionClaimVersion !== AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION) {
      throw new Error('unsupported')
    }
  } catch {
    throw new Error('agent_session_claim_unavailable')
  }
}

function claimsEqual(
  actual: AgentSessionExecutionClaim,
  expected: AgentSessionExecutionClaim
): boolean {
  return (
    actual.digestVersion === expected.digestVersion &&
    actual.keyId === expected.keyId &&
    actual.identityDigest === expected.identityDigest &&
    actual.worktreeScopeDigest === expected.worktreeScopeDigest &&
    actual.agent === expected.agent
  )
}

function surfacesEqual(
  actual: AgentSessionSurfaceBinding,
  expected: AgentSessionSurfaceBinding
): boolean {
  return (
    actual.worktreeId === expected.worktreeId &&
    actual.tabId === expected.tabId &&
    actual.leafId === expected.leafId &&
    actual.terminalHandle === expected.terminalHandle
  )
}

export function validateClaimedSshSpawn(
  result: PtySpawnResult,
  expected: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
  }
): ClaimedSshSpawnValidation {
  const claimed = result.agentSessionEnsure
  if (!isAgentSessionClaimedSpawnResult(claimed)) {
    // Why: without a disposition we cannot prove the returned PTY was newly
    // created, so killing it could terminate a canonical adopted owner.
    return { valid: false, cleanup: 'none', error: 'execution_owner_unavailable' }
  }
  const cleanup = claimed.disposition === 'created' ? 'created' : 'none'
  if (claimed.owner.ptyId !== result.id) {
    return { valid: false, cleanup, error: 'agent_session_ownership_unknown' }
  }
  if (!claimsEqual(claimed.owner.claim, expected.claim)) {
    return { valid: false, cleanup, error: 'agent_session_ownership_unknown' }
  }
  if (
    claimed.disposition === 'created' &&
    !surfacesEqual(claimed.owner.surface, expected.surface)
  ) {
    return { valid: false, cleanup, error: 'agent_session_ownership_unknown' }
  }
  if (!isPtyIncarnationId(result.incarnationId)) {
    return { valid: false, cleanup, error: 'agent_session_ownership_unknown' }
  }
  return { valid: true }
}
