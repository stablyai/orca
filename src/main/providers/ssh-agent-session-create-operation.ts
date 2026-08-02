import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION } from '../../shared/agent-session-host-authority'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtySpawnResult } from './pty-spawn-result'
import type { PtySpawnOptions } from './types'
import type { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'
import type { SshPtyReceivingActivationLease } from './ssh-pty-notification-routing'
import {
  parsePtySourceReceivingActivation,
  type PtySourceReceivingActivation
} from '../../shared/pty-source-receiving-activation'
import { validateClaimedSshSpawn } from './ssh-agent-session-claim-validation'

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
  beforeResolve?: (result: unknown) => void
}): Promise<unknown> {
  try {
    const options =
      args.signal || args.beforeResolve
        ? { signal: args.signal, beforeResolve: args.beforeResolve }
        : undefined
    return await args.mux.request('pty.spawn', args.params, options)
  } catch (error) {
    if (!args.operationId) {
      throw error
    }
    const spawnError = error instanceof Error ? error : new Error(String(error))
    // Why: after request dispatch, either an old relay or a capable replay ledger may own a PTY.
    throw Object.assign(spawnError, { agentSessionOperationOutcome: 'unknown' as const })
  }
}

export async function spawnFreshSshPty(args: {
  mux: SshChannelMultiplexer
  options: PtySpawnOptions
  params: Record<string, unknown>
  exitRaceTracker: SshPtySpawnExitRaceTracker
  installSourceActivation: (
    relayPtyId: string,
    activation: PtySourceReceivingActivation
  ) => SshPtyReceivingActivationLease
  rememberPtyIncarnation: (relayPtyId: string, incarnationId: unknown) => void
  acceptLivePty: (appPtyId: string) => void
  toAppPtyId: (relayPtyId: string) => string
}): Promise<PtySpawnResult> {
  const operation = args.exitRaceTracker.begin()
  let sourceActivationLease: SshPtyReceivingActivationLease | undefined
  try {
    const result = await requestSshAgentSessionCreate({
      mux: args.mux,
      operationId: args.options.agentSessionCreateOperationId,
      signal: args.options.signal,
      params: args.params,
      beforeResolve: (value) => {
        sourceActivationLease = installSpawnSourceActivation(value, args.installSourceActivation)
      }
    })
    if (args.options.agentSessionCreateOperationId) {
      assertSshAgentSessionCreateResult(result)
    }
    const spawnResult = parseSshPtySpawnResult(result)
    if (args.exitRaceTracker.didMatchingExitArrive(operation, spawnResult)) {
      throw Object.assign(new Error('agent_session_exited_during_start'), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    }
    const claimed = spawnResult.agentSessionEnsure
    if (args.options.agentSessionEnsure) {
      const validation = validateClaimedSshSpawn(spawnResult, args.options.agentSessionEnsure)
      if (!validation.valid) {
        if (validation.cleanup === 'created' && typeof spawnResult.id === 'string') {
          try {
            await args.mux.request('pty.shutdown', { id: spawnResult.id, immediate: true })
          } catch {
            throw new Error('execution_owner_unavailable')
          }
        }
        throw new Error(validation.error)
      }
    }
    const id = args.toAppPtyId(spawnResult.id)
    args.rememberPtyIncarnation(spawnResult.id, spawnResult.incarnationId)
    args.acceptLivePty(id)
    const mappedResult = {
      ...spawnResult,
      id,
      ...(claimed
        ? {
            agentSessionEnsure: {
              ...claimed,
              owner: { ...claimed.owner, ptyId: args.toAppPtyId(claimed.owner.ptyId) }
            }
          }
        : {})
    }
    sourceActivationLease?.commit()
    return mappedResult
  } catch (error) {
    if (sourceActivationLease && !(await sourceActivationLease.rollback())) {
      throw new Error('execution_owner_unavailable')
    }
    throw error
  } finally {
    args.exitRaceTracker.finish(operation)
  }
}

function installSpawnSourceActivation(
  value: unknown,
  install: (
    relayPtyId: string,
    activation: PtySourceReceivingActivation
  ) => SshPtyReceivingActivationLease
): SshPtyReceivingActivationLease | undefined {
  const result = parseSshPtySpawnResult(value)
  const activation = result.sourceActivation
  if (!activation) {
    return undefined
  }
  return install(result.id, activation)
}

function parseSshPtySpawnResult(value: unknown): PtySpawnResult {
  const result =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as PtySpawnResult)
      : ({} as PtySpawnResult)
  const activation = parsePtySourceReceivingActivation(result.sourceActivation)
  if (
    activation &&
    (typeof result.id !== 'string' ||
      result.id.length === 0 ||
      !isPtyIncarnationId(result.incarnationId) ||
      activation.ptyIncarnation !== result.incarnationId)
  ) {
    throw new Error('Invalid SSH PTY source activation identity')
  }
  return activation ? { ...result, sourceActivation: activation } : result
}
