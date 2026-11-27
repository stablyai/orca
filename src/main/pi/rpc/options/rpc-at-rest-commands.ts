import { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import {
  isLegacyAgentSessionAccountHome,
  requireLegacyAgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../../../native-chat/agent-session-wire/options/at-rest-command-catalog'
import { runAgentModelCatalogSession } from '../../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { supportsSupervisedProviderChildLocation } from '../../../provider-process/supervised-provider-child-location'
import { buildPiRpcLaunch, piRpcSessionlessEnvironment } from '../launch/rpc-launch'
import { checkPiRpcVersion, resolvePiRpcInvocation } from '../launch/rpc-launch-resolution'
import { readPiRpcCommands } from './rpc-options'
import { connectPiCatalog } from './rpc-catalog-connection'
import type { PiModelCatalogProbeDeps } from './rpc-model-catalog-probe'

type PiAtRestCommandDeps = Pick<
  PiModelCatalogProbeDeps,
  | 'resolveEnvironment'
  | 'refreshEnvironmentAfterMiss'
  | 'resolveCommandSettings'
  | 'resolveCommand'
  | 'probeVersion'
  | 'connect'
> & {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
}

export class PiAtRestCommandCatalog extends AtRestCommandCatalog {
  private readonly pending: Set<Promise<AtRestCommandScan>>

  constructor(deps: PiAtRestCommandDeps) {
    const pool = new PrioritySemaphore(2)
    const pending = new Set<Promise<AtRestCommandScan>>()
    super({
      label: 'pi-commands',
      scanTimeoutMs: 9_000,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      accepts: (record) =>
        record.provider === 'pi' &&
        supportsSupervisedProviderChildLocation(record.location) &&
        isLegacyAgentSessionAccountHome(record.accountHome),
      scan: (record, cwd, current, _generation, signal, admitted, demand) => {
        const scan = async (): Promise<AtRestCommandScan> => {
          const release = await pool.acquire(() => (demand.independent ? 0 : 1), signal)
          try {
            const operation = { current, signal }
            const wait = <T>(work: Promise<T>) => waitForPromiseWithSignal(work, signal)
            const { env, command, prefixArgs } = await wait(
              resolvePiRpcInvocation({
                operation,
                accountDir: requireLegacyAgentSessionAccountHome(record.accountHome).path,
                resolveEnvironment: deps.resolveEnvironment,
                commandSettings: deps.resolveCommandSettings?.(),
                resolveCommand: deps.resolveCommand,
                refreshEnvironmentAfterMiss: deps.refreshEnvironmentAfterMiss,
                resolveWorkingDirectory: () => cwd
              })
            )
            const releaseVersion = await wait(
              checkPiRpcVersion({ command, prefixArgs, cwd, env, operation }, deps.probeVersion)
            )
            if (releaseVersion.status === 'tooOld') {
              throw new Error('Pi command discovery unavailable')
            }
            signal.throwIfAborted()
            const launch = buildPiRpcLaunch({
              command,
              prefixArgs,
              cwd,
              ...piRpcSessionlessEnvironment(env),
              fullAccess: true
            })
            admitted()
            const result = await runAgentModelCatalogSession(
              () =>
                (deps.connect ?? connectPiCatalog)({
                  ...launch,
                  args: [...launch.args, '--no-session']
                }),
              readPiRpcCommands,
              { label: 'pi commands', signal }
            )
            return { commands: result.commands, fromAgent: true }
          } finally {
            release()
          }
        }
        const result = scan().finally(() => pending.delete(result))
        pending.add(result)
        return result
      }
    })
    this.pending = pending
  }

  async closeAll(): Promise<void> {
    this.dispose()
    await Promise.allSettled(this.pending)
  }
}
