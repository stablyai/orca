import type { StructuredAgentRuntimeRegistration } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { AtRestCommandCatalog } from '../native-chat/agent-session-wire/options/at-rest-command-catalog'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { resolveTraexReadLaunch } from './traex-launch-resolution'
import { TraexAppServerConnection } from './traex-app-server-connection'
import { readTraexSessionCommands } from './traex-session-commands'

export function createTraexAtRestCommands(
  context: Parameters<StructuredAgentRuntimeRegistration['createAdapter']>[0]
) {
  const active = new Set<Promise<unknown>>()
  const catalog = new AtRestCommandCatalog({
    label: 'trae',
    accepts: (record) =>
      record.provider === 'trae' &&
      isLegacyAgentSessionAccountHome(record.accountHome) &&
      supportsSupervisedProviderChildLocation(record.location),
    resolveWorkspacePath: context.deps.resolveWorkspacePath,
    scan: async (record, cwd, current, _generation, signal, admitted) => {
      const launch = await resolveTraexReadLaunch(context, record.accountHome, cwd, { signal })
      if (!current()) {
        return { commands: undefined, fromAgent: false }
      }
      const work = runAgentModelCatalogSession(
        () => new TraexAppServerConnection(launch),
        async (connection) => {
          await connection.initialize()
          admitted()
          return readTraexSessionCommands(connection, cwd, true)
        },
        { label: 'trae', signal, timeoutMs: 15_000 }
      )
      active.add(work)
      try {
        return { commands: await work, fromAgent: true }
      } finally {
        active.delete(work)
      }
    }
  })
  return Object.assign(catalog, {
    closeAll: async () => {
      catalog.dispose()
      await Promise.allSettled(active)
    }
  })
}
