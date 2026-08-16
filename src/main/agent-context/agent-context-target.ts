import { homedir } from 'node:os'
import { posix } from 'node:path'
import type { AgentContextReport } from '../../shared/agent-context'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import type { ResolvedSkillDiscoveryTarget } from '../skills/skill-discovery-target'
import { inspectAgentContext } from './agent-context-inspection'

/**
 * Inspect the agent context on the same host skill discovery resolved. WSL
 * targets are read through their `\\wsl.localhost` UNC mount so the report
 * carries POSIX display paths while node fs opens the Windows view of them.
 */
export async function inspectAgentContextOnTarget(
  resolved: ResolvedSkillDiscoveryTarget
): Promise<AgentContextReport> {
  if (resolved.kind === 'wsl') {
    const distro = resolved.distro
    return inspectAgentContext({
      target: { kind: 'wsl', distro, homeDir: resolved.homeDir, cwd: resolved.cwd },
      toAccessPath: (displayPath) => toWindowsWslPath(displayPath, distro),
      pathApi: posix
    })
  }
  return inspectAgentContext({
    target: { kind: 'native-host', homeDir: homedir(), cwd: resolved.cwd ?? null }
  })
}
