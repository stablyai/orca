import type {
  AgentLaunchProfile,
  AgentProfileSnapshot,
  ProfileAgent,
  ProfileIdentity
} from '../../shared/agent-launch-profile'
import type { ProfileAliasSource } from '../agent-profile-discovery/literal-alias'
import type { ProfileHostContext } from './host-discovery'
import type { ProfileProviderAdapter } from './provider-adapters'

export type {
  AgentProfileConnectionInput,
  AgentProfileCandidate
} from '../../shared/agent-profile-connection'
export type PreparedAgentProfile = {
  /** Previous host observation is accepted only as an argv label, never executed. */
  priorExecutable?: string
  snapshot: AgentProfileSnapshot
  envPatch: Record<string, string>
  envToDelete: string[]
  release: () => void
}
export type ProfileConnectionDependencies = {
  host: ProfileHostContext
  adapters: Record<ProfileAgent, ProfileProviderAdapter>
  store: {
    read: () => readonly AgentLaunchProfile[] | Promise<readonly AgentLaunchProfile[]>
    write: (profiles: AgentLaunchProfile[]) => Promise<void>
  }
  detectExecutable?: (agent: ProfileAgent) => Promise<string>
  readAliases?: () => Promise<ProfileAliasSource[]>
  inspectExternal?: (
    agent: ProfileAgent,
    executable: string,
    home: string
  ) => Promise<ProfileIdentity>
}
