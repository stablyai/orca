import type { CommandHandler } from '../dispatch'
import {
  formatSavedServer,
  formatSavedServerList,
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
import { quoteCliCommandArgument } from '../shell-command-quote'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'

export const ENVIRONMENT_HANDLERS: Record<string, CommandHandler> = {
  'server name': async ({ client, flags, json }) => {
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
          'This Orca server does not support machine names. Update Orca on that server and try again.'
        )
      }
      await client.call('settings.update', { machineName: requestedName })
    }
    // A blank override restores the detected name; read it from the server after writing.
    const status = await client.call<RuntimeStatus>('status.get')
    printResult({ ...status, result: describeRuntimeHost(status.result) }, json, formatHostName)
  },
  'server add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    refuseReservedEnvironmentName(name)
    const pairingCode = await exchangeCliPairingCode(getRequiredStringFlag(flags, 'pairing-code'))
    const server = redactRuntimeEnvironment(
      addEnvironmentFromPairingCode(getDefaultUserDataPath(), {
        name,
        pairingCode
      })
    )
    printResult(
      localSuccess({ server }),
      json,
      (result: EnvironmentAddResult) => `Saved server ${result.server.name} (${result.server.id}).`
    )
  },
  'host list': async ({ client, flags, json }) => {
    rejectLocalPairingStoreRetargeting(
      flags,
      '`orca host list`. It answers from this computer\u2019s own pairing store, so a routed answer would name servers saved on a different computer.',
      'Run `orca host list` on that computer to see the SSH connections registered there.'
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
    const servers = listEnvironments(getDefaultUserDataPath()).map((server) => ({
      kind: 'server' as const,
      name: server.name,
      id: server.id,
      selector: `--server ${quoteCliCommandArgument(server.id)}`
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
      ...servers
    ]
    printResult(localSuccess({ hosts }), json, formatHostList)
  },
  'host rm': async ({ client, flags, json }) => {
    rejectLocalPairingStoreRetargeting(
      flags,
      '`orca host rm`. It removes an SSH connection from the Orca on this computer, the same one `orca host list` reads.',
      'Run `orca host rm` on that computer to remove an SSH connection registered there.'
    )
    const targetId = requireSshHostFlag(flags)
    // Unlike listSshTargets, this keeps runtime_unavailable instead of reporting an unknown target.
    const { targets } = await fetchSshTargetSummaries<SshTargetSummary>(client)
    const target = targets.find((candidate) => candidate.id === targetId)
    if (!target) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown SSH target in --host ssh:${targetId}: the Orca on this computer has no SSH target with that id.`,
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
  'server list': async ({ flags, json }) => {
    rejectLocalPairingStoreRetargeting(
      flags,
      '`orca server list`. Saved servers are stored on this computer, so no other server could answer.',
      'Run `orca server list` on that computer to see the servers saved there.'
    )
    const servers = listEnvironments(getDefaultUserDataPath()).map(redactRuntimeEnvironment)
    printResult(localSuccess({ servers }), json, formatSavedServerList)
  },
  'server show': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'server')
    const server = redactRuntimeEnvironment(resolveEnvironment(getDefaultUserDataPath(), selector))
    printResult(localSuccess({ server }), json, ({ server: value }) => formatSavedServer(value))
  },
  'server rm': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'server')
    const removed = redactRuntimeEnvironment(removeEnvironment(getDefaultUserDataPath(), selector))
    printResult(
      localSuccess({ removed }),
      json,
      (result: EnvironmentRemoveResult) =>
        `Removed server ${result.removed.name} (${result.removed.id}).`
    )
  }
}

function describeRuntimeHost(status: RuntimeStatus): HostNameResult {
  return {
    ...(status.machineName ? { machineName: status.machineName } : {}),
    ...(status.hostPlatform ? { platform: status.hostPlatform } : {})
  }
}

/** The local row of `host list` still prints when the Orca on this computer is not running. */
async function readLocalHostDescriptor(client: RuntimeClient): Promise<HostNameResult> {
  try {
    return describeRuntimeHost((await client.call<RuntimeStatus>('status.get')).result)
  } catch {
    return {}
  }
}

// Both listings read the local pairing store; reject flags that imply a different server.
function rejectLocalPairingStoreRetargeting(
  flags: Map<string, string | boolean>,
  suffix: string,
  crossHostNextStep: string
): void {
  rejectRemoteSelectionFlags(flags, suffix, {
    nextSteps: [crossHostNextStep, 'Drop the flag to answer for this computer.']
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
      ? 'A saved server is removed with `orca server rm --server <id>`.'
      : host.kind === 'local' || normalizeTypedName(named) === LOCAL_HOST_LIST_NAME
        ? 'This computer is always listed and cannot be removed.'
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
