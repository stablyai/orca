import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtySpawnOptions, PtySpawnResult } from './types'
import { toRelaySshPtyId } from './ssh-pty-id'
import type { RemoteCliBridgeEnv } from './ssh-pty-provider-contract'
import type { SshPtyProviderOutputState } from './ssh-pty-provider-output-state'
import { spawnFreshSshPty } from './ssh-agent-session-create-operation'
import { reattachSshPtySessionWithExitFence } from './ssh-pty-session-reattach'
import { buildSshPtySpawnRequest } from './ssh-pty-spawn-request'
import type { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'
import { SSH_SESSION_EXPIRED_ERROR } from './ssh-pty-errors'

type CapabilityProbe = (options: { signal?: AbortSignal }) => Promise<boolean>

/** What the two spawn paths need from the provider that owns them. Capability
 *  probes stay indirected through the provider so its caching/stubbing applies. */
export type SshPtySpawnContext = {
  mux: SshChannelMultiplexer
  connectionId: string
  exitRaceTracker: SshPtySpawnExitRaceTracker
  outputState: SshPtyProviderOutputState
  acceptLivePty: (id: string) => void
  toAppPtyId: (id: string) => string
  remoteCliBridgeEnv?: RemoteCliBridgeEnv
  supportsAgentSessionClaims: CapabilityProbe
  supportsAgentSessionCreateOperations: CapabilityProbe
  supportsLaunchTokenEcho: CapabilityProbe
}

export async function dispatchSshPtySpawn(
  context: SshPtySpawnContext,
  opts: PtySpawnOptions
): Promise<PtySpawnResult> {
  if (opts.agentSessionEnsure && opts.sessionId) {
    throw new Error('agent_session_claim_unavailable')
  }
  if (opts.agentSessionEnsure) {
    const supportsClaims = await context.supportsAgentSessionClaims({ signal: opts.signal })
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    if (!supportsClaims) {
      throw new Error('agent_session_claim_unavailable')
    }
  }
  if (opts.sessionId) {
    return await reattachExistingSession(context, opts)
  }
  return await spawnFreshSession(context, opts)
}

async function reattachExistingSession(
  context: SshPtySpawnContext,
  opts: PtySpawnOptions & { sessionId?: string }
): Promise<PtySpawnResult> {
  let result: Awaited<ReturnType<typeof reattachSshPtySessionWithExitFence>> | undefined
  try {
    result = await reattachSshPtySessionWithExitFence({
      mux: context.mux,
      connectionId: context.connectionId,
      sessionId: opts.sessionId as string,
      options: opts,
      exitRaceTracker: context.exitRaceTracker,
      installSourceActivation: (relayPtyId, activation) =>
        context.outputState.installReceivingActivation(relayPtyId, activation),
      rememberPtyIncarnation: (relayPtyId, incarnationId) =>
        context.outputState.rememberPtyIncarnation(relayPtyId, incarnationId)
    })
    if (result.sourceRecovery?.status === 'restoreRequired') {
      throw new Error(
        `${SSH_SESSION_EXPIRED_ERROR}: ${toRelaySshPtyId(context.connectionId, result.id)}`
      )
    }
    context.acceptLivePty(result.id)
    result.sourceActivationLease?.commit()
    const {
      sourceActivationLease: _lease,
      sourceRecovery: _sourceRecovery,
      ...spawnResult
    } = result
    return spawnResult
  } catch (error) {
    result?.sourceActivationLease?.rollback()
    throw error
  }
}

async function spawnFreshSession(
  context: SshPtySpawnContext,
  opts: PtySpawnOptions
): Promise<PtySpawnResult> {
  // Why probed before dispatch: an old relay accepts the token and never re-lists it, so
  // withhold it and let reconciliation keep its pre-token identification for this host.
  // Concurrent because the two capabilities are independent; their results are
  // cached for this provider generation, including definitive old-relay negatives.
  // Skipped entirely when nothing is probed: awaiting settled promises would push a plain
  // spawn's `pty.spawn` dispatch out of the caller's turn.
  const [supportsCreateOperation, supportsLaunchTokenEcho] =
    opts.agentSessionCreateOperationId || opts.launchToken
      ? await Promise.all([
          opts.agentSessionCreateOperationId
            ? context.supportsAgentSessionCreateOperations({ signal: opts.signal })
            : Promise.resolve(false),
          opts.launchToken
            ? context.supportsLaunchTokenEcho({ signal: opts.signal })
            : Promise.resolve(false)
        ])
      : [false, false]
  if (opts.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  if (opts.agentSessionCreateOperationId && !supportsCreateOperation) {
    // Why: host routing owns legacy selection; a changed relay must not downgrade after dispatch.
    throw new Error('execution_owner_unavailable')
  }
  return await spawnFreshSshPty({
    mux: context.mux,
    options: opts,
    params: buildSshPtySpawnRequest({
      options: opts,
      remoteCliBridgeEnv: context.remoteCliBridgeEnv,
      supportsCreateOperation,
      supportsLaunchTokenEcho
    }),
    exitRaceTracker: context.exitRaceTracker,
    installSourceActivation: (id, activation) =>
      context.outputState.installReceivingActivation(id, activation),
    rememberPtyIncarnation: (id, incarnation) =>
      context.outputState.rememberPtyIncarnation(id, incarnation),
    acceptLivePty: context.acceptLivePty,
    toAppPtyId: context.toAppPtyId
  })
}
