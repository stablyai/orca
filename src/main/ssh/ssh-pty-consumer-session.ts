import {
  PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
  type PtyConsumerSessionGrant
} from '../../shared/pty-consumer-session'
import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../../shared/pty-source-credit-contract'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'

export const SSH_PTY_OPEN_CLIENT_METHOD = 'pty.openClient'
export const SSH_PTY_OPEN_CLIENT_TIMEOUT_MS = 10_000

export type SshPtyConsumerOwnerState = {
  mode: 'negotiated'
  clientInstanceId: string
  clientGeneration: number
  ownerGeneration: number
  ownerLease: string
  outputFlowControl?: {
    version: 1
    windowSu: number
  }
}

export type SshPtyLegacyFallbackState = {
  mode: 'legacy-fallback'
  clientInstanceId: string
  serverBuildId: string
}

export type SshPtyConsumerSessionState = SshPtyConsumerOwnerState | SshPtyLegacyFallbackState

export type OpenSshPtyConsumerSessionOptions = {
  clientInstanceId: string
  expectedServerBuildId: string | undefined
  resume?: Pick<SshPtyConsumerOwnerState, 'ownerGeneration' | 'ownerLease'>
  outputFlowControl?: {
    requestedWindowSu: number
  }
  allowSameBuildLegacyFallback?: boolean
}

function validateGrant(
  value: unknown,
  options: OpenSshPtyConsumerSessionOptions
): PtyConsumerSessionGrant {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Remote relay returned an invalid pty.openClient grant')
  }
  if (!options.expectedServerBuildId) {
    throw new Error('Local relay build identity is unavailable')
  }
  const grant = value as Partial<PtyConsumerSessionGrant>
  if (
    grant.protocolVersion !== PTY_CONSUMER_SESSION_PROTOCOL_VERSION ||
    grant.serverBuildId !== options.expectedServerBuildId
  ) {
    throw new Error(
      `Remote relay session contract mismatch — expected build ${options.expectedServerBuildId}, got ${grant.serverBuildId ?? 'unknown'}`
    )
  }
  if (
    !Number.isSafeInteger(grant.clientGeneration) ||
    grant.clientGeneration! <= 0 ||
    grant.role !== 'session-owner' ||
    !Number.isSafeInteger(grant.ownerGeneration) ||
    grant.ownerGeneration! <= 0 ||
    typeof grant.ownerLease !== 'string' ||
    grant.ownerLease.length === 0 ||
    grant.ownerLease.length > 512
  ) {
    throw new Error('Remote relay did not grant an authenticated PTY session owner')
  }
  const requestedFlow = options.outputFlowControl
  const grantedFlow = grant.capabilities?.outputFlowControl
  if (requestedFlow) {
    if (
      grantedFlow?.version !== 1 ||
      !Number.isSafeInteger(grantedFlow.windowSu) ||
      grantedFlow.windowSu <= 0 ||
      grantedFlow.windowSu > requestedFlow.requestedWindowSu
    ) {
      throw new Error('Remote relay did not grant the offered PTY output-flow-control capability')
    }
  } else if (grantedFlow) {
    throw new Error('Remote relay granted an unoffered PTY output-flow-control capability')
  }
  return grant as PtyConsumerSessionGrant
}

export async function openSshPtyConsumerSession(
  mux: SshChannelMultiplexer,
  options: OpenSshPtyConsumerSessionOptions
): Promise<SshPtyConsumerSessionState> {
  let result: unknown
  try {
    result = await mux.request(
      SSH_PTY_OPEN_CLIENT_METHOD,
      {
        protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
        clientInstanceId: options.clientInstanceId,
        requestedRole: 'session-owner',
        ...(options.resume ? { resume: options.resume } : {}),
        ...(options.outputFlowControl
          ? {
              capabilities: {
                outputFlowControl: {
                  versions: [1],
                  requestedWindowSu: options.outputFlowControl.requestedWindowSu
                }
              }
            }
          : {})
      },
      { timeoutMs: SSH_PTY_OPEN_CLIENT_TIMEOUT_MS }
    )
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    if (
      code === -32601 &&
      options.allowSameBuildLegacyFallback === true &&
      typeof options.expectedServerBuildId === 'string' &&
      options.expectedServerBuildId.length > 0
    ) {
      return Object.freeze({
        mode: 'legacy-fallback',
        clientInstanceId: options.clientInstanceId,
        serverBuildId: options.expectedServerBuildId
      })
    }
    throw error
  }
  const grant = validateGrant(result, options)
  return {
    mode: 'negotiated',
    clientInstanceId: options.clientInstanceId,
    clientGeneration: grant.clientGeneration,
    ownerGeneration: grant.ownerGeneration!,
    ownerLease: grant.ownerLease!,
    ...(grant.capabilities?.outputFlowControl
      ? { outputFlowControl: grant.capabilities.outputFlowControl }
      : {})
  }
}

export const SSH_PTY_SOURCE_WINDOW_SU = DEFAULT_PTY_SOURCE_WINDOW_SU
