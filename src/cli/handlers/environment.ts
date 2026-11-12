import type { CommandHandler } from '../dispatch'
import {
  formatEnvironment,
  formatEnvironmentList,
  formatHostList,
  formatHostName,
  printResult,
  type HostNameResult
} from '../format'
import { parseHostFlag } from '../execution-host-flag'
import {
  fetchSshTargetSummaries,
  listSshTargets,
  LOCAL_HOST_LIST_NAME,
  normalizeTypedName,
  type SshTargetSummary
} from '../host-selector-alternatives'
import {
  getDefaultUserDataPath,
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeRpcSuccess
} from '../runtime-client'

import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { redactRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment,
  resolveEnvironment,
  type EnvironmentAddResult,
  type EnvironmentRemoveResult
} from '../runtime/environments'
import { exchangeCliPairingCode } from '../runtime/environment-pairing-exchange'
import { refuseReservedEnvironmentName } from '../local-environment-selector'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'

export const ENVIRONMENT_HANDLERS: Record<string, CommandHandler> = {
  'host name': async ({ client, flags, json }) => {
    const requestedName = flags.get('name')
    if (requestedName !== undefined && typeof requestedName !== 'string') {
      throw new RuntimeClientError('invalid_argument', 'Missing value for --name')
    }
    if (typeof requestedName === 'string') {
      // Check name support before an older settings schema can reject the write as invalid_params.
      const current = await client.call<RuntimeStatus>('status.get')
      if (current.result.machineName === undefined) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'This Orca runtime does not support machine names. Update Orca on that host and try again.'
        )
      }
      await client.call('settings.update', { machineName: requestedName })
    }
    // A blank override restores the detected name; read it from the runtime after writing.
    const status = await client.call<RuntimeStatus>('status.get')
    printResult({ ...status, result: describeRuntimeHost(status.result) }, json, formatHostName)
  },
  'environment add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    refuseReservedEnvironmentName(name)
    const pairingCode = await exchangeCliPairingCode(getRequiredStringFlag(flags, 'pairing-code'))
    const environment = redactRuntimeEnvironment(
      addEnvironmentFromPairingCode(getDefaultUserDataPath(), {
        name,
        pairingCode
      })
    )
    printResult(
      localSuccess({ environment }),
      json,
      (result: EnvironmentAddResult) =>
        `Saved environment ${result.environment.name} (${result.environment.id}).`
    )
  },
  'host list': async ({ client, flags, json }) => {
    rejectLocalPairingStoreRetargeting(
      flags,
      '`orca host list`. It answers from this machine\u2019s own pairing store, so a routed answer would name servers paired with a different machine.',
      'Run `orca host list` on that machine to see the SSH targets registered there.'
    )
    const sshTargets = (await listSshTargets(client)).map((target) => ({
      kind: 'ssh' as const,
      name: target.label,
      id: target.id,
      selector: `--host ssh:${target.id}`,
      ...(target.connected === undefined ? {} : { connected: target.connected }),
      ...(target.connectionStatus ? { connectionStatus: target.connectionStatus } : {}),
      ...(target.remotePlatform ? { platform: target.remotePlatform } : {})
    }))
    // Read the local pairing store without dialing every server, so listing works offline.
    const localStatus = await readLocalHostDescriptor(client)
    const environments = listEnvironments(getDefaultUserDataPath()).map((environment) => ({
      kind: 'environment' as const,
      name: environment.name,
      id: environment.id,
      selector: `--environment ${environment.name}`
    }))
    const hosts = [
      {
        kind: 'local' as const,
        name: LOCAL_HOST_LIST_NAME,
        id: 'local',
        selector: '--host local',
        ...localStatus,
        platform: localStatus.platform ?? process.platform
      },
      ...sshTargets,
      ...environments
    ]
    printResult(localSuccess({ hosts }), json, formatHostList)
  },
  'host rm': async ({ client, flags, json }) => {
    rejectLocalPairingStoreRetargeting(
      flags,
      '`orca host rm`. It removes an SSH target from this machine\u2019s own Orca runtime, the same one `orca host list` reads.',
      'Run `orca host rm` on that machine to remove an SSH target registered there.'
    )
    const targetId = requireSshHostFlag(flags)
    // Unlike listSshTargets, this keeps runtime_unavailable instead of reporting an unknown target.
    const { targets } = await fetchSshTargetSummaries<SshTargetSummary>(client)
    const target = targets.find((candidate) => candidate.id === targetId)
    if (!target) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown SSH target in --host ssh:${targetId}: this Orca host has no SSH target with that id.`,
        {
          knownSshTargets: targets,
          nextSteps: ['Run `orca host list` to see each SSH target and its --host ssh:<id> flag.']
        }
      )
    }
    // Same RPC as the UI: the runtime tombstones the alias so the ~/.ssh/config import skips it.
    const response = await client.call('ssh.removeTarget', { targetId })
    const removed = { kind: 'ssh' as const, name: target.label, id: target.id }
    printResult(
      { ...response, result: { removed } },
      json,
      (result: { removed: typeof removed }) =>
        `Removed SSH target ${result.removed.name} (${result.removed.id}).`
    )
  },
  'environment list': async ({ flags, json }) => {
    rejectLocalPairingStoreRetargeting(
      flags,
      '`orca environment list`. Paired servers are stored on this machine, so there is no other host to ask.',
      'Run `orca environment list` on that machine to see the servers paired with it.'
    )
    const environments = listEnvironments(getDefaultUserDataPath()).map(redactRuntimeEnvironment)
    printResult(localSuccess({ environments }), json, formatEnvironmentList)
  },
  'environment show': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const environment = redactRuntimeEnvironment(
      resolveEnvironment(getDefaultUserDataPath(), selector)
    )
    printResult(localSuccess({ environment }), json, ({ environment: value }) =>
      formatEnvironment(value)
    )
  },
  'environment rm': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const removed = redactRuntimeEnvironment(removeEnvironment(getDefaultUserDataPath(), selector))
    printResult(
      localSuccess({ removed }),
      json,
      (result: EnvironmentRemoveResult) =>
        `Removed environment ${result.removed.name} (${result.removed.id}).`
    )
  }
}

function describeRuntimeHost(status: RuntimeStatus): HostNameResult {
  return {
    ...(status.machineName ? { machineName: status.machineName } : {}),
    ...(status.hostPlatform ? { platform: status.hostPlatform } : {})
  }
}

/** The local row of `host list` still prints when this machine's runtime is not running. */
async function readLocalHostDescriptor(client: RuntimeClient): Promise<HostNameResult> {
  try {
    return describeRuntimeHost((await client.call<RuntimeStatus>('status.get')).result)
  } catch {
    return {}
  }
}

// Both listings read the local pairing store; reject flags that imply a different runtime.
function rejectLocalPairingStoreRetargeting(
  flags: Map<string, string | boolean>,
  suffix: string,
  crossHostNextStep: string
): void {
  rejectRemoteSelectionFlags(flags, suffix, {
    nextSteps: [crossHostNextStep, 'Drop the flag to answer for this machine.']
  })
}

function requireSshHostFlag(flags: Map<string, string | boolean>): string {
  const host = parseHostFlag(flags)
  if (host?.kind === 'ssh') {
    return host.targetId
  }
  if (!host) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --host ssh:<target-id>')
  }
  const named = host.kind === 'alias' ? host.alias : host.id
  const nextStep =
    host.kind === 'runtime'
      ? 'A paired Orca server is removed with `orca environment rm --environment <name>`.'
      : host.kind === 'local' || normalizeTypedName(named) === LOCAL_HOST_LIST_NAME
        ? 'This machine is always listed and cannot be removed.'
        : 'Pass the SSH target id as --host ssh:<target-id>; `orca host list` prints it.'
  throw new RuntimeClientError(
    'invalid_argument',
    `\`orca host rm\` removes saved SSH targets only, and --host ${named} is not one.`,
    { nextSteps: [nextStep, 'Run `orca host list` to see each SSH target and its --host flag.'] }
  )
}

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}
