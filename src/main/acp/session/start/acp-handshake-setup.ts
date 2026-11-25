import type { InitializeResponse } from '../../generated/acp-protocol.generated'
import type { AcpLaunchSpec } from '../../launch/acp-launch-contract'
import type { AcpStructuredLaunch } from '../../launch/acp-structured-launch-resolution'

export function resolveAcpSessionMeta(
  launch: Pick<AcpStructuredLaunch, 'sessionMeta' | 'takesSessionMeta' | 'sessionMetaOptional'>,
  initialized: InitializeResponse,
  agentName: string
): AcpStructuredLaunch['sessionMeta'] {
  const refused = Boolean(
    launch.sessionMeta && launch.takesSessionMeta && !launch.takesSessionMeta(initialized)
  )
  if (refused && !launch.sessionMetaOptional) {
    const version = initialized.agentInfo?.version
    throw new Error(
      `${agentName}${version ? ` ${version}` : ''} cannot take this chat's standing instructions, so it did not start`
    )
  }
  return refused ? undefined : launch.sessionMeta
}

export function buildAcpStartupSetup(
  spec: Pick<AcpLaunchSpec, 'authMethod' | 'authMethodUnavailableMessage' | 'resumePreference'>,
  launch: Pick<AcpStructuredLaunch, 'env' | 'antigravityChatAuth' | 'additionalDirectories'>,
  initialized: InitializeResponse
) {
  // Choose authentication using the execution host's launch environment.
  const authMethodId = spec.authMethod?.({
    advertised: (initialized.authMethods ?? []).map((method) => method.id),
    env: launch.env,
    antigravityChatAuth: launch.antigravityChatAuth
  })
  return {
    authMethodId,
    authMethodUnavailableMessage: spec.authMethodUnavailableMessage,
    resumePreference: spec.resumePreference,
    ...(launch.additionalDirectories?.length &&
    initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories != null
      ? { additionalDirectories: launch.additionalDirectories }
      : {})
  }
}
