import type { ClaudeStructuredLaunchResolverDeps } from '../claude/claude-structured-launch-resolution'
import {
  agentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { AgentSessionStoredAgent } from '../../shared/agent-session-stored-agent'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { hasIsolatedClaudeAccountAuth } from '../claude-accounts/isolated-account-auth'
// Captures host-owned profile identity without acquiring credentials at create-intent time.
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { AgentProfileSnapshot } from '../../shared/agent-launch-profile'
import type { AgentProfileConnectionService } from '../agent-profiles/connection-service'
import { assertAgentProfileEnvironment } from '../agent-profiles/terminal-command'
import type { PreparedAgentProfile } from '../agent-profiles/connection-contracts'

export async function resolveStructuredProfileSnapshot(
  service: AgentProfileConnectionService | undefined,
  id: string,
  agent: StructuredAgentId,
  location: AgentSessionExecutionLocation
): Promise<AgentProfileSnapshot> {
  if (!service || location.executionHostId !== 'local' || location.wslDistro !== null) {
    throw new Error('Agent profiles require the local host runtime.')
  }
  const snapshot = await service.resolveSnapshotById(id, { mode: 'structured', resume: false })
  if (snapshot.agent !== agent) {
    throw new Error('The selected profile belongs to another agent.')
  }
  return snapshot
}

export function structuredProfileEnvironment(
  prepared: PreparedAgentProfile,
  inherited: NodeJS.ProcessEnv,
  explicit: Record<string, string> = {}
): Record<string, string> {
  assertAgentProfileEnvironment(prepared, explicit)
  const deleted = new Set(prepared.envToDelete.map((key) => key.toUpperCase()))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...inherited, ...explicit })) {
    if (value !== undefined && !deleted.has(key.toUpperCase())) {
      env[key] = value
    }
  }
  return { ...env, ...prepared.envPatch }
}

export async function structuredClaudeProfileInvocationDeps(
  profile: PreparedAgentProfile,
  deps: Pick<ClaudeStructuredLaunchResolverDeps, 'resolveInheritedEnv' | 'resolveEnv'>
): Promise<
  Pick<
    ClaudeStructuredLaunchResolverDeps,
    'resolveCommand' | 'resolveEnv' | 'resolveInheritedEnv' | 'resolveAuthPolicy'
  >
> {
  const environment = structuredProfileEnvironment(
    profile,
    deps.resolveInheritedEnv ? await deps.resolveInheritedEnv() : process.env,
    await deps.resolveEnv?.()
  )
  return {
    resolveCommand: () => profile.snapshot.executable,
    resolveEnv: () => undefined,
    resolveInheritedEnv: async () => environment,
    resolveAuthPolicy: () => ({ stripAuthEnv: true, isolatedCredentials: true })
  }
}

export function structuredAgentProfileAccountHome(input: {
  agent: AgentSessionStoredAgent
  agentProfile?: AgentProfileSnapshot
  managedAccounts?: readonly { id: string; managedAuthPath: string }[]
  selectedPath: string
  path: string
}): AgentSessionAccountHome {
  const account =
    !input.agentProfile && input.agent.agent === 'claude'
      ? input.managedAccounts?.find(
          (entry) =>
            entry.managedAuthPath === input.selectedPath &&
            hasIsolatedClaudeAccountAuth(entry.managedAuthPath)
        )
      : undefined
  return {
    ...agentSessionAccountHome(input.agent, input.path),
    ...(input.agentProfile ? { agentProfile: input.agentProfile } : {}),
    ...(account ? { claudeAccountId: account.id } : {})
  }
}

export type StructuredAgentSessionCreateIntentInput = {
  agentProfileId?: string
  envelope: { sessionId: string; clientOperationId: string }
  worktree: string
  agent: StructuredAgentId
  callerKey?: string
  resumeFrom?: { providerSessionId: string }
}

export async function prepareStructuredProfile(
  service: AgentProfileConnectionService | undefined,
  snapshot: AgentProfileSnapshot,
  resume: boolean
): Promise<PreparedAgentProfile> {
  if (!service) {
    throw new Error('Profile runtime is unavailable.')
  }
  return service.prepare(snapshot, { mode: 'structured', resume })
}
