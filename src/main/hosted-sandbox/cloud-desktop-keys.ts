// Desktop-sealed agent API keys (Settings → Agent API Keys) and Orca Cloud workspaces. On any other
// host those keys ride each agent launch as plain env. An Orca Cloud VM must never hold a model key,
// so they are not sent there at all: the user saves a key as a personal Cloud secret instead (one key
// per click), and the VM then gets a placeholder the egress proxy swaps.
import {
  resolveAgentApiKeyLaunchEnv,
  withAgentApiKeyLaunchEnv
} from '../agent-api-keys/agent-api-key-launch-env'
import { withAgentApiKeyRuntimeEnv } from '../agent-api-keys/agent-api-key-runtime-call'
import { isCloudSshAlias } from '../cloud-ssh/cloud-ssh-config'
import { getSshTargetRegistryStore } from '../ssh/targets/ssh-target-registry'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getConnectionExecutionHostId, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'

// Set once the desktop starts (registerCloudSecretsHandlers); this module stays free of Electron
// because launch assembly that the headless runtime also loads imports it.
let desktopUserDataPath: string | null = null
export function setCloudDesktopKeysUserDataPath(path: string): void {
  desktopUserDataPath = path
}

/** Orca Cloud sandboxes answer on Vercel Sandbox routes. */
const ORCA_CLOUD_ENDPOINT_HOST = /\.vercel\.run$/i

function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname
  } catch {
    return null
  }
}

/**
 * Whether `environmentId` is an Orca Cloud VM. Fails closed: a VM-provisioned host this desktop has no
 * provider record for, or any host on a Vercel Sandbox route, counts as Orca Cloud.
 */
export function isOrcaCloudRuntimeEnvironment(
  userDataPath: string,
  environmentId: string
): boolean {
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (record) => record.runtimeEnvironmentId === environmentId
  )
  if (runtime) {
    return runtime.recipe?.provider === 'orca-cloud' || runtime.recipe?.provider === undefined
  }
  let environment: ReturnType<typeof resolveEnvironment> | null = null
  try {
    environment = resolveEnvironment(userDataPath, environmentId)
  } catch {
    return false
  }
  if (environment.source === 'ephemeral-vm') {
    return true
  }
  return (environment.endpoints ?? []).some((endpoint) => {
    const host = endpointHost(endpoint.endpoint)
    return host !== null && ORCA_CLOUD_ENDPOINT_HOST.test(host)
  })
}

/** A host id no host-scoped key names, so only keys set for every host match (the ones a new VM would get). */
const ANY_CLOUD_HOST = toRuntimeExecutionHostId('orca-cloud')

/** The sealed value of the desktop key `envName` for `agent`, unsealed for one cloud write. */
export async function desktopKeyValueForCloud(
  agent: TuiAgent,
  envName: string
): Promise<string | null> {
  const env = await resolveAgentApiKeyLaunchEnv(agent, ANY_CLOUD_HOST)
  return env[envName] ?? null
}

/**
 * A runtime call's params with this computer's Agent API Keys for the agent it starts, except on an
 * Orca Cloud VM: there they would sit in plaintext, so the user saves them as Cloud secrets instead
 * (the VM then only sees egress placeholders).
 */
export async function withHostAgentApiKeyEnv(
  environmentId: string,
  method: string,
  params: unknown,
  readStatus: Parameters<typeof withAgentApiKeyRuntimeEnv>[3]
): Promise<unknown> {
  // Without the desktop's records nothing can be ruled out, so no keys go anywhere.
  if (
    desktopUserDataPath === null ||
    isOrcaCloudRuntimeEnvironment(desktopUserDataPath, environmentId)
  ) {
    return params
  }
  return withAgentApiKeyRuntimeEnv(environmentId, method, params, readStatus)
}

/**
 * An SSH target that reaches an Orca Cloud workspace (`orca ssh` writes `orca-*` aliases that proxy
 * through the Orca CLI; OpenSSH config Includes can surface them as targets).
 */
export function isOrcaCloudSshConnection(connectionId: string | null | undefined): boolean {
  if (!connectionId) {
    return false
  }
  const target = getSshTargetRegistryStore()?.getTarget(connectionId)
  if (!target) {
    return false
  }
  return (
    [target.configHost, target.host, target.label].some(
      (value) => value !== undefined && isCloudSshAlias(value)
    ) || /\bssh-proxy\b/.test(target.proxyCommand ?? '')
  )
}

/** A local or SSH launch env with this computer's Agent API Keys, except over SSH into an Orca Cloud workspace. */
export async function withHostAgentApiKeyLaunchEnv(
  env: Record<string, string> | undefined,
  agent: TuiAgent | undefined,
  connectionId: string | null | undefined
): Promise<Record<string, string> | undefined> {
  if (isOrcaCloudSshConnection(connectionId)) {
    return env
  }
  return withAgentApiKeyLaunchEnv(env, agent, getConnectionExecutionHostId(connectionId))
}
