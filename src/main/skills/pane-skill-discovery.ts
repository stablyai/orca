import type { Repo } from '../../shared/types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { SkillDiscoveryForPaneResponse } from '../../shared/skills'
import {
  getSshSkillDiscoveryProvider,
  SSH_SKILL_DISCOVERY_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-skill-discovery-dispatch'
import { SshSkillDiscoveryUnsupportedError } from '../providers/ssh-skill-discovery-provider'
import { discoverSkillsOnTarget, resolveSkillDiscoveryTarget } from './skill-discovery-target'

/** Executes a pane-scoped scan on the workspace's execution host. `cwd` and
 *  `connectionId` are runtime-resolved, never renderer input. */
export async function discoverPaneSkills(args: {
  worktreeId: string
  cwd: string
  connectionId?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  repos: readonly Repo[]
  signal?: AbortSignal
}): Promise<SkillDiscoveryForPaneResponse> {
  if (args.connectionId) {
    const provider = getSshSkillDiscoveryProvider(args.connectionId)
    if (!provider) {
      throw new Error(SSH_SKILL_DISCOVERY_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    try {
      return { status: 'ok', result: await provider.discover(args.cwd, { signal: args.signal }) }
    } catch (error) {
      if (error instanceof SshSkillDiscoveryUnsupportedError) {
        return { status: 'relay-upgrade-required' }
      }
      throw error
    }
  }
  const target = resolveSkillDiscoveryTarget({
    cwd: args.cwd,
    worktreeId: args.worktreeId,
    ...(args.projectRuntime ? { projectRuntime: args.projectRuntime } : {})
  })
  return {
    status: 'ok',
    result: await discoverSkillsOnTarget(target, args.repos, args.signal)
  }
}
