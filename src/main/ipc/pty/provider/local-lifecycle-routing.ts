import type { LocalPtyLifecycleProvider } from '../../../providers/pty/local-lifecycle-provider'
import { inspectPtyProviderProcess } from '../../../providers/pty/process-inspection'
import { getLocalPtyBackendId } from '../../../../shared/terminal/pty/lifecycle/pty-backend-id'
import { selectLocalPtyBackend } from './backend-routing'

/** An inventory failure from either owner is not a proof of absence. Do not send a Rex id to the daemon. */
export function createLocalLifecycleProvider(
  standard: LocalPtyLifecycleProvider,
  rex?: LocalPtyLifecycleProvider
): LocalPtyLifecycleProvider {
  const owner = (id: string): LocalPtyLifecycleProvider => selectLocalPtyBackend(id, standard, rex)
  return {
    async listProcesses(opts) {
      const ids = opts?.ptyIds
      if (ids) {
        const standardIds = ids.filter((id) => getLocalPtyBackendId(id) === 'default')
        const rexIds = ids.filter((id) => getLocalPtyBackendId(id) === 'rex')
        if (rexIds.length && !rex) {
          throw new Error('Rex PTY backend unavailable for inventory')
        }
        return (
          await Promise.all([
            ...(standardIds.length
              ? [standard.listProcesses({ ...opts, ptyIds: standardIds })]
              : []),
            ...(rex && rexIds.length ? [rex.listProcesses({ ...opts, ptyIds: rexIds })] : [])
          ])
        ).flat()
      }
      return (
        await Promise.all([standard.listProcesses(opts), ...(rex ? [rex.listProcesses(opts)] : [])])
      ).flat()
    },
    probePtyLiveness: async (id) => {
      try {
        return (await owner(id).probePtyLiveness?.(id)) ?? null
      } catch {
        return null
      }
    },
    shutdown: (id, opts) => owner(id).shutdown(id, opts),
    hasPty: (id) => owner(id).hasPty?.(id) ?? false,
    getForegroundProcess: (id) => owner(id).getForegroundProcess(id),
    hasChildProcesses: (id) => owner(id).hasChildProcesses(id),
    inspectProcess: (id, opts) => inspectPtyProviderProcess(owner(id), id, opts),
    // Agent launches currently remain on the standard backend.
    ...(standard.supportsAgentSessionClaims
      ? { supportsAgentSessionClaims: standard.supportsAgentSessionClaims.bind(standard) }
      : {}),
    ...(standard.supportsAgentSessionCreateOperations
      ? {
          supportsAgentSessionCreateOperations:
            standard.supportsAgentSessionCreateOperations.bind(standard)
        }
      : {})
  }
}
