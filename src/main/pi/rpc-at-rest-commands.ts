import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../native-chat/agent-session-wire/options/at-rest-command-catalog'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { runPiRpcCatalogSession, type PiRpcCatalogSessionDeps } from './rpc-catalog-session'
import { readPiRpcCommands } from './rpc-options'

export type PiAtRestCommandDeps = PiRpcCatalogSessionDeps & {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
}

export class PiAtRestCommandCatalog extends AtRestCommandCatalog {
  private readonly pending = new Set<Promise<AtRestCommandScan>>()

  constructor(deps: PiAtRestCommandDeps) {
    const admission = new PrioritySemaphore(2)
    const lifetime = new AbortController()
    super({
      label: 'pi-commands',
      scanTimeoutMs: 20_000,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      accepts: (record) =>
        record.provider === 'pi' &&
        supportsSupervisedProviderChildLocation(record.location) &&
        isLegacyAgentSessionAccountHome(record.accountHome),
      scan: (record, cwd, _isCurrent, _generation, contextSignal, admitted, demand) => {
        const signal = AbortSignal.any([lifetime.signal, contextSignal])
        const run = async (): Promise<AtRestCommandScan> => {
          const release = await demand.acquire(admission, signal)
          try {
            signal.throwIfAborted()
            admitted()
            const result = await runPiRpcCatalogSession(
              deps,
              { accountHome: record.accountHome, cwd, signal },
              readPiRpcCommands
            )
            return { commands: result.commands, fromAgent: true }
          } finally {
            release()
          }
        }
        const completion = run()
        this.pending.add(completion)
        void completion.then(
          () => this.pending.delete(completion),
          () => this.pending.delete(completion)
        )
        return completion
      }
    })
    const disposeCatalog = this.dispose
    this.dispose = () => {
      lifetime.abort(new Error('Pi command discovery stopped'))
      disposeCatalog()
    }
  }

  async closeAll(): Promise<void> {
    this.dispose()
    await Promise.allSettled(this.pending)
  }
}
