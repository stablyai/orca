import type { StructuredAgentResolutionOperation } from '../../native-chat/agent-launch/structured-agent-command-resolution'
import { keptRunningProviderRelayPid } from '../../provider-relay/app-provider-relays'
import {
  checkAgentCliVersion,
  type AgentCliVersionCheck,
  type AgentCliVersionReader
} from '../../agent-launch/preflight/agent-cli-version-probe'
import type { AcpLaunchSpec } from './acp-launch-contract'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { noteAcpForkVersion } from '../capabilities/acp-fork-support'

/** Chats whose last launch skipped its check for a kept agent; a fresh spawn instead must not. */
const skippedForKept = new Set<string>()

export function takeAcpKeptVersionSkip(chat: string): boolean {
  return skippedForKept.delete(chat)
}

export async function checkAcpLaunchVersion(
  spec: AcpLaunchSpec,
  launch: Pick<AcpStructuredLaunch, 'command' | 'prefixArgs' | 'cwd' | 'env'> & {
    operation?: StructuredAgentResolutionOperation
    /** The chat launching; one whose agent the terminal host kept starts no program to check. */
    chat?: string
  },
  wantVersion: boolean,
  read?: AgentCliVersionReader
): Promise<AgentCliVersionCheck> {
  if (launch.chat !== undefined && keptRunningProviderRelayPid(launch.chat) !== null) {
    skippedForKept.add(launch.chat)
    return { status: 'unknown', version: null }
  }
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
