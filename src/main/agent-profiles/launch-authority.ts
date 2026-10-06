// Sanitizes provider-owned identity and launch authority checks at the common service boundary.
import type { ProfileAgent, ProfileIdentity } from '../../shared/agent-launch-profile'
import type { PreparedAgentProfile, ProfileConnectionDependencies } from './connection-contracts'
import { sanitizedProfilePreparationError } from './preparation-error'
export type ProfileLaunchContext = { cwd: string; env: NodeJS.ProcessEnv }
export async function validatePreparedProfileLaunch(
  adapters: ProfileConnectionDependencies['adapters'],
  prepared: PreparedAgentProfile,
  context: ProfileLaunchContext
): Promise<void> {
  if (prepared.snapshot.binding.kind === 'external') {
    return
  }
  const validate = adapters[prepared.snapshot.agent].validateLaunch
  if (prepared.snapshot.agent === 'codex' && !validate) {
    throw new Error('Managed Codex launch authority inspection is unavailable.')
  }
  try {
    await validate?.(prepared.snapshot, context)
  } catch (error) {
    throw sanitizedProfilePreparationError(
      error,
      'Managed profile launch authority could not be verified.'
    )
  }
}

export function profileIdentityMetadata(identity: ProfileIdentity): ProfileIdentity {
  return identity.kind === 'verified'
    ? { kind: 'verified', subject: identity.subject, displayName: identity.displayName }
    : { kind: 'unverified', reason: identity.reason }
}
export async function inspectExternalProfileIdentity(
  dependencies: Pick<ProfileConnectionDependencies, 'inspectExternal'>,
  agent: ProfileAgent,
  executable: string,
  home: string
): Promise<ProfileIdentity> {
  if (!dependencies.inspectExternal) {
    return {
      kind: 'unverified',
      reason: 'Provider read-only identity inspection is unavailable.'
    }
  }
  try {
    return profileIdentityMetadata(await dependencies.inspectExternal(agent, executable, home))
  } catch {
    throw new Error('Provider identity inspection failed. Reconnect the configuration folder.')
  }
}
