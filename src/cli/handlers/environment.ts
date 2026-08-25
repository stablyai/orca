import type { CommandHandler } from '../dispatch'
import { formatEnvironment, formatEnvironmentList, formatHostList, printResult } from '../format'
import { listSshTargets } from '../host-selector-alternatives'
import { getDefaultUserDataPath, RuntimeClientError } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment,
  type EnvironmentAddResult,
  type EnvironmentRemoveResult
} from '../runtime/environments'

export const ENVIRONMENT_HANDLERS: Record<string, CommandHandler> = {
  'host add': async ({ client, flags, json }) => {
    const alias = getRequiredStringFlag(flags, 'ssh-config')
    const ensured = await client.call<{
      target: { id: string; label: string }
      created: boolean
    }>('ssh.ensureConfigTarget', { alias })
    const connect = flags.get('connect') === true
    if (connect) {
      await client.call('ssh.connect', { targetId: ensured.result.target.id })
    }
    printResult(ensured, json, ({ target, created }) => {
      const action = created ? 'Added' : 'Found'
      const connection = connect ? ' and connected' : ''
      return `${action} SSH host ${target.label} (${target.id})${connection}.`
    })
  },
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
  // Why: an agent told "run it on <name>" had nowhere to look. `orca environment list` showed
  // paired servers only, and nothing in the CLI listed SSH targets at all, so the wrong-axis
  // guess was the only move available. This is the one place that answers both.
  'host list': async ({ client, json }) => {
    const environments = listEnvironments(getDefaultUserDataPath()).map((environment) => ({
      kind: 'environment' as const,
      name: environment.name,
      id: environment.id,
      selector: `--environment ${environment.name}`
    }))
    const sshTargets = (await listSshTargets(client)).map((target) => ({
      kind: 'ssh' as const,
      name: target.label,
      id: target.id,
      selector: `--host ssh:${target.id}`
    }))
    const hosts = [
      { kind: 'local' as const, name: 'this machine', id: 'local', selector: '--host local' },
      ...sshTargets,
      ...environments
    ]
    printResult(localSuccess({ hosts }), json, formatHostList)
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
