import type { CommandHandler } from '../dispatch'
import { formatEnvironment, formatEnvironmentList, printResult } from '../format'
import { getDefaultUserDataPath } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment,
  type EnvironmentAddResult,
  type EnvironmentRemoveResult
} from '../runtime/environments'
import { startDevcontainerUp } from '../runtime/devcontainer-up'

export const ENVIRONMENT_HANDLERS: Record<string, CommandHandler> = {
  'environment add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const pairingCode = getRequiredStringFlag(flags, 'pairing-code')
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
  'environment devcontainer-up': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const container = getRequiredStringFlag(flags, 'container')
    const hostPort = getRequiredPortFlag(flags, 'host-port')
    const containerPort = getOptionalPortFlag(flags, 'container-port') ?? 6768
    const orcaBin = getOptionalStringFlag(flags, 'orca-bin') ?? 'orca'
    const bridgeName = getOptionalStringFlag(flags, 'bridge-name') ?? defaultBridgeName(name)

    const session = startDevcontainerUp({
      userDataPath: getDefaultUserDataPath(),
      name,
      container,
      hostPort,
      containerPort,
      orcaBin,
      bridgeName
    })
    const environment = redactRuntimeEnvironment(await session.ready)
    printResult(
      localSuccess({ environment }),
      json,
      (result: { environment: typeof environment }) => formatEnvironment(result.environment)
    )
    // Why: the devcontainer bridge and `orca serve` must keep running after
    // readiness so the paired desktop runtime remains reachable.
    await session.done
  },
  'environment list': async ({ json }) => {
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

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function getOptionalStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getRequiredPortFlag(flags: Map<string, string | boolean>, name: string): number {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return parsePortValue(name, value)
}

function getOptionalPortFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalStringFlag(flags, name)
  return value === undefined ? undefined : parsePortValue(name, value)
}

function parsePortValue(name: string, raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeClientError('invalid_argument', `Invalid --${name} value: ${raw}`)
  }
  return port
}

function defaultBridgeName(name: string): string {
  const suffix = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `orca-devcontainer-${suffix.length > 0 ? suffix : 'bridge'}`
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
