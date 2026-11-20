import type { StructuredAgentResolutionOperation } from '../../native-chat/agent-launch/structured-agent-command-resolution'
import {
  checkAgentCliVersion,
  type AgentCliVersionCheck,
  type AgentCliVersionReader
} from '../../agent-launch/preflight/agent-cli-version-probe'
import type { AcpLaunchSpec, ManagedCopySettings } from './acp-launch-contract'
import { managedAgentCommandFor } from '../../managed-agent-cli/managed-agent-cli-registry'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { noteAcpForkVersion } from '../capabilities/acp-fork-support'

export async function checkAcpLaunchVersion(
  spec: AcpLaunchSpec,
  launch: Pick<AcpStructuredLaunch, 'command' | 'prefixArgs' | 'cwd' | 'env'> & {
    operation?: StructuredAgentResolutionOperation
  },
  wantVersion: boolean,
  read?: AgentCliVersionReader
): Promise<AgentCliVersionCheck> {
  if (!spec.minimumVersions && !wantVersion) {
    noteAcpForkVersion(spec.agent, null)
    return { status: 'unknown', version: null }
  }
  const result = await checkAgentCliVersion(
    {
      program: launch.command,
      prefixArgs: [...launch.prefixArgs, ...(spec.versionArgs ?? [])],
      cwd: launch.cwd,
      env: launch.env,
      operation: launch.operation
    },
    spec.minimumVersions ?? [],
    read
  )
  noteAcpForkVersion(spec.agent, result.version)
  return result
}

/** The launch's version check, standing Orca's copy in for a user's own program that is too old,
 *  where the spec lets Orca's copy run: an own agy older than the floor would refuse every chat
 *  that Orca's current copy can serve. */
export async function checkAcpLaunchVersionOrCopy(
  spec: AcpLaunchSpec,
  launch: Pick<AcpStructuredLaunch, 'command' | 'prefixArgs' | 'cwd' | 'env'>,
  wantVersion: boolean,
  read: AgentCliVersionReader | undefined,
  settings: ManagedCopySettings | undefined
): Promise<{ command: string; prefixArgs: string[]; check: AgentCliVersionCheck }> {
  const check = await checkAcpLaunchVersion(spec, launch, wantVersion, read)
  const copy =
    check.status === 'tooOld' &&
    spec.managedCopyAllowed !== undefined &&
    spec.managedCopyAllowed(settings ?? {})
      ? managedAgentCommandFor(spec.agent, spec.command)
      : null
  if (!copy || copy === launch.command) {
    return { command: launch.command, prefixArgs: launch.prefixArgs, check }
  }
  const copyCheck = await checkAcpLaunchVersion(
    spec,
    { ...launch, command: copy, prefixArgs: [] },
    wantVersion,
    read
  )
  return copyCheck.status === 'tooOld'
    ? { command: launch.command, prefixArgs: launch.prefixArgs, check }
    : { command: copy, prefixArgs: [], check: copyCheck }
}
