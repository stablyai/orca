import { createProfileStateStartupTransfer } from '../persistence/loading-store/profile-state-startup-transfer'
import { normalizeExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { surfaceProfileDomainSchema } from '../../shared/workspace-surfaces/surface-profile-domain'
import type { ProfileStateAuthorityInitialState } from '../persistence/loading-store/profile-state-authority'
import type { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'

/** Migration uses the admitted snapshot before its exact revision transfers to the live writer. */
export function initializeProfileWorkspaceSurfaces(
  initial: ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority>
): ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority> {
  const state: Record<string, unknown> | undefined = initial.takeParsedState
    ? initial.takeParsedState()
    : initial.serializedState === undefined
      ? undefined
      : JSON.parse(initial.serializedState)
  // Preserve fresh-profile detection until Store has created the initial user defaults.
  if (state === undefined) {
    return {
      ...createProfileStateStartupTransfer(initial.authority, undefined),
      unboundPaneAliases: initial.unboundPaneAliases
    }
  }
  const domain = surfaceProfileDomainSchema.optional().parse(state.workspaceSurfaces)
  const partitions = state.workspaceSessionsByHostId
  const hosts = new Set([
    'local',
    ...Object.keys(domain?.hosts ?? {}),
    ...(partitions && typeof partitions === 'object' && !Array.isArray(partitions)
      ? Object.keys(partitions)
      : [])
  ])
  try {
    for (const hostId of hosts) {
      if (normalizeExecutionHostId(hostId) !== hostId) {
        throw new Error('Stored workspace surface host identity is invalid')
      }
      if (parseExecutionHostId(hostId)?.kind !== 'runtime') {
        initial.authority.executeSurfaceCommand({ type: 'initialize', hostId })
      }
    }
    return {
      ...initial.authority.readInitialState(),
      unboundPaneAliases: initial.unboundPaneAliases
    }
  } catch (error) {
    initial.authority.close()
    throw error
  }
}
