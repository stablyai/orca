// Why: mobile's protocol-version.ts copy omits the capability constants (mirrors
// MOBILE_AI_VAULT_CAPABILITY in agent-history-capability.ts). Keep this string in
// lockstep with src/shared/protocol-version.ts AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY.
export const MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY = 'agent-launch.identity.v1'

type StatusWithCapabilities = { capabilities?: string[] }

// Why: identity-only host launch (U7). When the host advertises this capability the
// client sends the agent identity (agentLaunch) and the host derives the command +
// env from its authenticated context; older hosts keep the legacy client-assembled
// startupCommand path for one release. A missing/unreachable status probe reads as
// unsupported so we degrade to the legacy path every host still accepts.
export function hostSupportsAgentLaunchIdentity(status: unknown): boolean {
  const capabilities = (status as StatusWithCapabilities | null)?.capabilities
  return (
    Array.isArray(capabilities) && capabilities.includes(MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY)
  )
}
