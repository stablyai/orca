import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'

type ExitProofInput = {
  identity: AgentSessionProcessIdentity
  waitForExit: () => Promise<unknown>
  probe?: (identity: AgentSessionProcessIdentity) => Promise<AgentSessionOwnerProbe>
  staleHandleProbeAttempts?: number
  staleHandleProbeIntervalMs?: number
}

const DEFAULT_STALE_HANDLE_PROBE_ATTEMPTS = 50
const DEFAULT_STALE_HANDLE_PROBE_INTERVAL_MS = 100

function provesRecordedProcessExited(proof: AgentSessionOwnerProbe): boolean {
  return proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch'
}

async function waitForRecordedProcessExit(input: ExitProofInput, staleError: Error): Promise<void> {
  const probe = input.probe ?? ((identity) => probeAgentSessionProcessIdentity({ identity }))
  const attempts = input.staleHandleProbeAttempts ?? DEFAULT_STALE_HANDLE_PROBE_ATTEMPTS
  const intervalMs = input.staleHandleProbeIntervalMs ?? DEFAULT_STALE_HANDLE_PROBE_INTERVAL_MS
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (provesRecordedProcessExited(await probe(input.identity))) {
      return
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw staleError
}

export async function waitForStructuredTuiExitProof(input: ExitProofInput): Promise<void> {
  try {
    await input.waitForExit()
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'terminal_handle_stale') {
      throw error
    }
    await waitForRecordedProcessExit(input, error)
  }
}
