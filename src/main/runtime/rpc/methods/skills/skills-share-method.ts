import { defineMethod } from '../../core'
import {
  AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE,
  AgentSkillShareRequestSchema,
  AgentSkillSharingError
} from '../../../../../shared/skills/sharing/agent-skill-sharing-contract'
import { discoverSkillsOnTarget } from '../../../../skills/discovery/skill-discovery-target'
import { runAsWslUserAct, wslDistroForPath } from '../../../../wsl/filesystem/wsl-unc-access-gate'
import { resolveDiscoveryTarget } from './skills-discovery-target'

export const SKILLS_SHARE_METHOD = defineMethod({
  name: 'skills.share',
  permission: 'skills-admin',
  share: 'not-shared',
  params: AgentSkillShareRequestSchema,
  handler: async (params, { runtime, signal, clientKind }) => {
    runtime.assertAgentSkillSharingAllowed()
    if (clientKind !== undefined) {
      throw new AgentSkillSharingError(
        AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE,
        'Publishing skills through a paired client is not supported. Run the command from Orca on the machine that stores the skills.'
      )
    }
    const resolvedTarget = await resolveDiscoveryTarget(params.target ?? {}, runtime)
    if (resolvedTarget.kind !== 'native-host') {
      throw new AgentSkillSharingError(
        AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE,
        'Publishing skills from a forwarded WSL session is not supported yet. Run the command from Orca on the machine that stores the skills.'
      )
    }
    // Sharing named skills is a user act: it may start the workspace's distro.
    const discover = async (readStoppedWslRootsFor?: { distros: readonly string[] }) =>
      runAsWslUserAct(resolvedTarget.cwd ? wslDistroForPath(resolvedTarget.cwd) : null, async () =>
        discoverSkillsOnTarget(resolvedTarget, runtime.listRepos(), {
          providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(resolvedTarget),
          refresh: true,
          ...(readStoppedWslRootsFor ? { readStoppedWslRootsFor } : {})
        })
      )
    // Selectors name skills, not folders: when one is missing, start only the distros left unread.
    let discovered = await discover()
    const unreadDistros = [
      ...new Set(
        discovered.sources.flatMap((source) =>
          source.skippedReason === 'unavailable' ? (wslDistroForPath(source.path) ?? []) : []
        )
      )
    ]
    if (
      unreadDistros.length > 0 &&
      !params.skillSelectors.every((selector) =>
        discovered.skills.some((skill) => skill.id === selector || skill.name === selector)
      )
    ) {
      discovered = await discover({ distros: unreadDistros })
    }
    return runtime.publishDiscoveredSkillsFromAgent(params, discovered.skills, signal)
  }
})
