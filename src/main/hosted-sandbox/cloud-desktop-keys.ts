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
import { AGENT_CREDENTIAL_NAMES } from '../../shared/cloud-secrets/cloud-secret-rules'
import { ORCA_CLOUD_HOST_RUNTIME_CAPABILITY } from '../../shared/hosted-sandbox/orca-cloud-host-capability'
import { listEphemeralVmRuntimes } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtime-store'
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

function isOrcaCloudEndpoint(endpoint: string): boolean {
  const host = endpointHost(endpoint)
  return host !== null && ORCA_CLOUD_ENDPOINT_HOST.test(host)
}

/** The verdict from this desktop's VM records, or null when it has no record for `environmentId`. */
function orcaCloudVerdictFromVmRecords(userDataPath: string, environmentId: string): boolean | null {
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (record) => record.runtimeEnvironmentId === environmentId
  )
  if (!runtime) {
    return null
  }
  return runtime.recipe?.provider === 'orca-cloud' || runtime.recipe?.provider === undefined
}

/**
 * Whether `environmentId` is an Orca Cloud VM. Fails closed: a VM-provisioned host this desktop has no
 * provider record for, or any host on a Vercel Sandbox route, counts as Orca Cloud.
 */
export async function isOrcaCloudRuntimeEnvironment(
  userDataPath: string,
  environmentId: string
): Promise<boolean> {
  const fromRecords = orcaCloudVerdictFromVmRecords(userDataPath, environmentId)
  if (fromRecords !== null) {
    return fromRecords
  }
  let environment: Awaited<ReturnType<typeof resolveEnvironment>>
  try {
    environment = await resolveEnvironment(userDataPath, environmentId)
  } catch {
    return false
  }
  if (environment.source === 'ephemeral-vm') {
    return true
  }
  return (environment.endpoints ?? []).some((endpoint) => isOrcaCloudEndpoint(endpoint.endpoint))
}

/**
 * Synchronous form for callers that already hold the connection: this desktop's VM records, else the
 * connection's own endpoint. It doesn't read the saved-server store, which is async.
 */
export function isOrcaCloudRuntimeConnection(
  userDataPath: string,
  environmentId: string,
  endpoint: string
): boolean {
  return orcaCloudVerdictFromVmRecords(userDataPath, environmentId) ?? isOrcaCloudEndpoint(endpoint)
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
    (await isOrcaCloudRuntimeEnvironment(desktopUserDataPath, environmentId))
  ) {
    return params
  }
  const withKeys = await withAgentApiKeyRuntimeEnv(environmentId, method, params, readStatus)
  if (withKeys === params) {
    return params
  }
  // Keys would go out: ask the host itself whether it is an Orca Cloud VM (covers a hand-made
  // pairing this desktop has no record of). An unanswered question sends nothing.
  return (await hostSaysOrcaCloud(environmentId, readStatus)) === false ? withKeys : params
}

const HOST_KIND_TTL_MS = 60_000
const hostKinds = new Map<string, { cloud: boolean; at: number }>()

async function hostSaysOrcaCloud(
  environmentId: string,
  readStatus: Parameters<typeof withAgentApiKeyRuntimeEnv>[3]
): Promise<boolean | null> {
  const cached = hostKinds.get(environmentId)
  if (cached && Date.now() - cached.at < HOST_KIND_TTL_MS) {
    return cached.cloud
  }
  try {
    const status = await readStatus()
    const result: unknown = status.ok ? status.result : null
    const capabilities =
      result !== null &&
      typeof result === 'object' &&
      'capabilities' in result &&
      Array.isArray(result.capabilities)
        ? result.capabilities
        : null
    if (!capabilities) {
      return null
    }
    const cloud = capabilities.includes(ORCA_CLOUD_HOST_RUNTIME_CAPABILITY)
    // Only "cloud" is remembered: it can only withhold keys. A "not cloud" answer is asked again on
    // the next launch, so a re-paired id that now points at a cloud VM is never sent keys from cache.
    if (cloud) {
      hostKinds.set(environmentId, { cloud, at: Date.now() })
    }
    return cloud
  } catch {
    return null
  }
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

/**
 * On an Orca Cloud VM (orcad runs with ORCA_IS_CLOUD=1, set by the image), a launch's env may not
 * set an agent credential to anything but the value this session already has (a stand-in or the
 * Cloud secret): a key carried in from a desktop, however the client is paired, is dropped here.
 */
export function withoutCarriedAgentCredentials(
  env: Record<string, string> | undefined,
  host: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> | undefined {
  if (!env || host.ORCA_IS_CLOUD !== '1') {
    return env
  }
  let kept: Record<string, string> | undefined
  for (const [name, value] of Object.entries(env)) {
    if (AGENT_CREDENTIAL_NAMES.includes(name) && value !== host[name]) {
      kept ??= { ...env }
      delete kept[name]
    }
  }
  return kept ?? env
}
