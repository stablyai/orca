import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { AGENT_KEY_LAUNCH_ENV_RUNTIME_CAPABILITY } from '../../shared/agent-api-keys/agent-key-launch-env-capability'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { resolveAgentApiKeyLaunchEnv } from './agent-api-key-launch-env'

type CapabilityVerdict = 'supported' | 'unsupported' | 'unknown'

export type AgentApiKeyRuntimeCall = {
  environmentId: string
  method: string
  params: unknown
  /** One `status.get` on the host behind `environmentId`. */
  readStatus: () => Promise<RuntimeRpcResponse<unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {}
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        record[key] = entry
      }
    }
  }
  return record
}

const CAPABILITY_TTL_MS = 60_000
const capabilityCache = new Map<string, { capabilities: readonly string[]; at: number }>()

async function hostSupportsKeyEnv(call: AgentApiKeyRuntimeCall): Promise<CapabilityVerdict> {
  const cached = capabilityCache.get(call.environmentId)
  if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) {
    return cached.capabilities.includes(AGENT_KEY_LAUNCH_ENV_RUNTIME_CAPABILITY)
      ? 'supported'
      : 'unsupported'
  }
  try {
    const status = await call.readStatus()
    const result = status.ok ? status.result : null
    const capabilities =
      isRecord(result) && Array.isArray(result.capabilities)
        ? result.capabilities.filter((entry): entry is string => typeof entry === 'string')
        : null
    if (!capabilities) {
      return 'unknown'
    }
    capabilityCache.set(call.environmentId, { capabilities, at: Date.now() })
    return capabilities.includes(AGENT_KEY_LAUNCH_ENV_RUNTIME_CAPABILITY)
      ? 'supported'
      : 'unsupported'
  } catch {
    return 'unknown'
  }
}

export function forgetAgentApiKeyHostCapabilities(environmentId: string): void {
  capabilityCache.delete(environmentId)
}

/** `params` with this desktop's stored keys for the agent process the call starts; untouched for anything else.
 * Keys ride this call over the host's encrypted connection and are never written to the host. */
export async function withAgentApiKeyRuntimeEnv(
  environmentId: string,
  method: string,
  params: unknown,
  readStatus: AgentApiKeyRuntimeCall['readStatus']
): Promise<unknown> {
  const call: AgentApiKeyRuntimeCall = { environmentId, method, params, readStatus }
  if (!isRecord(params)) {
    return params
  }
  const hostId = toRuntimeExecutionHostId(call.environmentId)
  if (method === 'terminal.create' || method === 'session.tabs.createTerminal') {
    // A caller-built launch names its agent; a plain shell or attach starts no agent process.
    if (!isTuiAgent(params.launchAgent) || params.command === undefined) {
      return params
    }
    const keys = await resolveAgentApiKeyLaunchEnv(params.launchAgent, hostId)
    if (Object.keys(keys).length === 0) {
      return params
    }
    // The caller's own env (an agent command override's VAR=…) still wins.
    return { ...params, env: { ...keys, ...stringRecord(params.env) } }
  }
  const hostBuiltLaunch =
    method === 'terminal.createAgentSession' ||
    (method === 'terminal.ensureAgentSession' && params.kind === 'explicit')
  if (!hostBuiltLaunch || !isTuiAgent(params.agent)) {
    return params
  }
  const keys = await resolveAgentApiKeyLaunchEnv(params.agent, hostId)
  if (Object.keys(keys).length === 0) {
    return params
  }
  // These schemas are strict: an older host would refuse the whole launch over an unknown field.
  if ((await hostSupportsKeyEnv(call)) !== 'supported') {
    return params
  }
  return { ...params, keyEnv: keys }
}
