import { isOpenSshConfigBackedTarget } from './ssh/system-ssh-args'
import { isRuntimeOwnedSshTargetId } from '../shared/execution-host'
import { classifyRemotePairingHostname } from '../shared/remote-pairing-address'
import {
  isUserManagedRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../shared/runtime-environments'
import type { SshTarget } from '../shared/ssh-types'

export type RuntimeEnvironmentEditorSshTargetResult =
  | { ok: true; target: SshTarget }
  | {
      ok: false
      reason: 'remote-runtime-unsupported' | 'runtime-ssh-target-required'
    }

function normalizeHostname(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

export function resolveRuntimeEnvironmentEditorSshTarget(
  environment: KnownRuntimeEnvironment,
  targets: readonly SshTarget[]
): RuntimeEnvironmentEditorSshTargetResult {
  if (
    !isUserManagedRuntimeEnvironment(environment) ||
    environment.connectionDependency === 'ssh-tunnel'
  ) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }

  const endpoint = environment.preferredEndpointId
    ? environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId)
    : environment.endpoints[0]
  if (!endpoint) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }

  let endpointUrl: URL
  try {
    endpointUrl = new URL(endpoint.endpoint)
  } catch {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
  if (
    (endpointUrl.protocol !== 'ws:' && endpointUrl.protocol !== 'wss:') ||
    !endpointUrl.hostname ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.pathname !== '/' ||
    endpointUrl.search ||
    endpointUrl.hash ||
    classifyRemotePairingHostname(endpointUrl.hostname) === 'loopback' ||
    ['0.0.0.0', '::'].includes(normalizeHostname(endpointUrl.hostname)) ||
    endpointUrl.port === '0'
  ) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }

  const hostname = normalizeHostname(endpointUrl.hostname)
  const usableTargets = targets.filter(
    (target) => target.owner?.type !== 'on-demand-runtime' && !isRuntimeOwnedSshTargetId(target.id)
  )
  const aliasMatches = usableTargets.filter(
    (target) =>
      isOpenSshConfigBackedTarget(target) && normalizeHostname(target.configHost) === hostname
  )
  if (aliasMatches.length > 0) {
    return aliasMatches.length === 1
      ? { ok: true, target: aliasMatches[0]! }
      : { ok: false, reason: 'runtime-ssh-target-required' }
  }

  const hostMatches = usableTargets.filter((target) => normalizeHostname(target.host) === hostname)
  return hostMatches.length === 1
    ? { ok: true, target: hostMatches[0]! }
    : { ok: false, reason: 'runtime-ssh-target-required' }
}
