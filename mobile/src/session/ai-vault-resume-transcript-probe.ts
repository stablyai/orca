import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { MOBILE_AI_VAULT_HOST_SCOPE_CAPABILITY } from '../agent-history/agent-history-capability'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { aiVaultTranscriptProbeRun } from './mobile-session-launch-operations'

export const TRANSCRIPT_PROBE_RPC_TIMEOUT_MS = 15_000

export type MobileTranscriptProbeResult = 'present' | 'missing' | 'unverifiable'

/**
 * Asks the serving host whether a host-local WSL transcript also exists on the SSH host a resume
 * targets. Only `missing` blocks: an older host, a refusal or a dropped link stays unverifiable
 * and keeps the pre-probe behavior.
 */
export async function probeMobileAiVaultTranscriptOnSshHost(args: {
  client: RpcOperationSender
  session: Pick<AiVaultSession, 'filePath'>
  targetHostId: `ssh:${string}` | null
  hostCapabilities: readonly string[] | undefined
}): Promise<MobileTranscriptProbeResult> {
  if (
    !args.targetHostId ||
    !args.hostCapabilities?.includes(MOBILE_AI_VAULT_HOST_SCOPE_CAPABILITY)
  ) {
    return 'unverifiable'
  }
  try {
    const response = await aiVaultTranscriptProbeRun.request(
      args.client,
      { executionHostId: args.targetHostId, filePath: args.session.filePath },
      { timeoutMs: TRANSCRIPT_PROBE_RPC_TIMEOUT_MS }
    )
    if (!response.ok) {
      return 'unverifiable'
    }
    return aiVaultTranscriptProbeRun.interpret(response)?.status ?? 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}

export type MobileTranscriptProbeSelection<T> =
  | { kind: 'resume'; candidate: T }
  | { kind: 'missing' }

/**
 * Picks which same-path workspace a WSL-fallback resume goes into. The first `present` wins; with
 * none present, the first `unverifiable` candidate keeps the pre-probe behavior (proceed); only
 * when every candidate is verified `missing` does the resume block.
 *
 * Why sequential: the common case is one or two candidates and a hit on the first stops the walk,
 * so parallel probes would add SSH round trips through the serving host for no latency win. The
 * caller caps the list (MAX_TRANSCRIPT_PROBE_CANDIDATES), which bounds the worst case. Candidates
 * without a probe host are never blocked.
 */
export async function selectMobileAiVaultTranscriptProbeCandidate<
  T extends { transcriptProbeHostId?: `ssh:${string}` }
>(args: {
  client: RpcOperationSender
  session: Pick<AiVaultSession, 'filePath'>
  candidates: readonly T[]
  hostCapabilities: readonly string[] | undefined
  assertCurrentOwner: () => void
}): Promise<MobileTranscriptProbeSelection<T>> {
  let firstUnverifiable: T | null = null
  let sawMissing = false
  for (const candidate of args.candidates) {
    const result = await probeMobileAiVaultTranscriptOnSshHost({
      client: args.client,
      session: args.session,
      targetHostId: candidate.transcriptProbeHostId ?? null,
      hostCapabilities: args.hostCapabilities
    })
    args.assertCurrentOwner()
    if (result === 'present') {
      return { kind: 'resume', candidate }
    }
    if (result === 'missing') {
      sawMissing = true
    } else {
      firstUnverifiable ??= candidate
    }
  }
  if (firstUnverifiable) {
    return { kind: 'resume', candidate: firstUnverifiable }
  }
  return sawMissing ? { kind: 'missing' } : { kind: 'resume', candidate: args.candidates[0] }
}
