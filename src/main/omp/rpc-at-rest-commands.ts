import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { AtRestCommandCatalog } from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { StructuredAgentModelCatalogContext } from '../runtime/structured-agent-runtime-registration-types'
import { readPiRpcCommands } from '../pi/rpc-options'
import { runOmpRpcCatalogSession } from './rpc-catalog-session'

export function createOmpRpcAtRestCommands(
  context: StructuredAgentModelCatalogContext
): AtRestCommandCatalog {
  const probes = new PrioritySemaphore(2)
  return new AtRestCommandCatalog({
    label: 'omp-rpc',
    resolveWorkspacePath: context.deps.resolveWorkspacePath,
    accepts: (record) =>
      record.provider === 'omp' &&
      isLegacyAgentSessionAccountHome(record.accountHome) &&
      supportsSupervisedProviderChildLocation(record.location),
    missingWorkspaceIsFailure: true,
    scanTimeoutMs: 9_000,
    scan: async (record, cwd, current, _generation, signal, admitted, demand) => {
      const release = await demand.acquire(probes, signal)
      try {
        admitted()
        const commands = await runOmpRpcCatalogSession(
          context,
          record.accountHome,
          {
            kind: 'command',
            cwd,
            operation: { signal, current },
            extraArgs: record.launchArgs ?? (await context.deps.resolveLaunchArgs('omp'))
          },
          async (connection) => (await readPiRpcCommands(connection)).commands
        )
        return { commands, fromAgent: true }
      } finally {
        release()
      }
    }
  })
}
