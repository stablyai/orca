import { AGENT_HOOK_REASONIX_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { resolveReasonixExecutionHostConfig } from '../main/reasonix/execution-host-config'

export async function detectReasonixManagedHookCapability(agents: readonly string[]): Promise<{
  capabilities?: string[]
  reasonixConfigHome?: string
}> {
  if (process.platform === 'win32' || !agents.includes('reasonix')) {
    return {}
  }
  try {
    const reasonixConfigHome = await resolveReasonixExecutionHostConfig()
    return { capabilities: [AGENT_HOOK_REASONIX_RUNTIME_CAPABILITY], reasonixConfigHome }
  } catch {
    // A refused root cannot authorize a managed hook installer.
    return {}
  }
}
