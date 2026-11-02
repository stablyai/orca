import {
  isSkillInstallProviderId,
  type SkillInstallProviderId
} from '../shared/skill-install-providers'

const CANONICAL_PROVIDER_BY_SKILLS_CLI_KEY = new Map<string, SkillInstallProviderId>([
  ['claude-code', 'claude'],
  ['opencode', 'opencode']
])

export function skillsCliAgentAliases(
  agentKeys: Readonly<Record<string, string | null>>
): ReadonlyMap<string, SkillInstallProviderId> {
  const providersByKey = new Map<string, SkillInstallProviderId[]>()
  for (const [agent, key] of Object.entries(agentKeys)) {
    if (!key || !isSkillInstallProviderId(agent)) {
      continue
    }
    const providers = providersByKey.get(key) ?? []
    providers.push(agent)
    providersByKey.set(key, providers)
  }

  const aliases = new Map<string, SkillInstallProviderId>()
  for (const [key, providers] of providersByKey) {
    const canonical =
      providers.length === 1 ? providers[0] : CANONICAL_PROVIDER_BY_SKILLS_CLI_KEY.get(key)
    if (!canonical || !providers.includes(canonical)) {
      throw new Error(`Skills CLI agent key "${key}" needs an explicit canonical provider.`)
    }
    aliases.set(key, canonical)
  }
  return aliases
}
