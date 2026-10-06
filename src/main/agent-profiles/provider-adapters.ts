import { CODEX_PROFILE_ROUTING_ENV } from '../codex-accounts/profile-launch-authority'
// Provider account ownership stays with injected runtime services.
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import type {
  AgentProfileSnapshot,
  ProfileAgent,
  ProfileIdentity
} from '../../shared/agent-launch-profile'

export type ProfilePreparationOptions = { resume: boolean; mode: 'terminal' | 'structured' }
export type ManagedProfileObservation = { home: string; identity: ProfileIdentity }
export type ManagedProfilePreparation = {
  home: string
  envPatch: Record<string, string>
  envToDelete: string[]
  release: () => void
}
export type ManagedProfileCallbacks = {
  validateLaunch?: (
    snapshot: AgentProfileSnapshot,
    context: { cwd: string; env: NodeJS.ProcessEnv }
  ) => Promise<void>
  inspectManaged: (accountId: string) => Promise<ManagedProfileObservation>
  prepareManaged: (
    accountId: string,
    options: ProfilePreparationOptions
  ) => Promise<ManagedProfilePreparation>
}
export type ProfileProviderAdapter = ManagedProfileCallbacks & {
  agent: ProfileAgent
  homeVariable: string
  authVariables: readonly string[]
}

export function createClaudeProfileAdapter(
  callbacks: ManagedProfileCallbacks
): ProfileProviderAdapter {
  return {
    ...callbacks,
    agent: 'claude',
    homeVariable: 'CLAUDE_CONFIG_DIR',
    authVariables: [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
  }
}
export function createCodexProfileAdapter(
  callbacks: ManagedProfileCallbacks
): ProfileProviderAdapter {
  return {
    ...callbacks,
    agent: 'codex',
    homeVariable: 'CODEX_HOME',
    authVariables: ['OPENAI_API_KEY', 'CODEX_API_KEY', ...CODEX_PROFILE_ROUTING_ENV]
  }
}
