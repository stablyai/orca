import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import type { Store } from '../../../persistence'
import { getPtyIpc } from '../../pty-host-bindings'
import { resolvePersistedStablePaneOwner } from '../pane/stable-owner'
import { ptyOwnership } from '../provider/ownership-state'
import { sshProviders, tryGetProviderForPty } from '../provider/registry'

export function installPtyHasPtyIpc(deps: {
  store?: Store
  getLocalPtyProviderStartupPromise: (connectionId?: string | null) => Promise<void> | undefined
}): void {
  getPtyIpc().handle(
    'pty:hasPty',
    async (
      _event,
      args: { id: string; paneKey?: string; worktreeId?: string }
    ): Promise<boolean | null> => {
      if (
        typeof args?.id !== 'string' ||
        args.id.length === 0 ||
        args.id.length > 512 ||
        args.id.startsWith('remote:')
      ) {
        return null
      }
      const ownedConnectionId = ptyOwnership.get(args.id)
      const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(args.id) : null
      const connectionId = ownedConnectionId ?? parsedSshId?.connectionId
      const startupPromise = deps.getLocalPtyProviderStartupPromise(connectionId)
      if (startupPromise) {
        await startupPromise
      }
      let expectedIncarnationId: string | undefined
      if (args.paneKey !== undefined || args.worktreeId !== undefined) {
        if (!args.paneKey || !args.worktreeId || connectionId) {
          return null
        }
        const owner = resolvePersistedStablePaneOwner(
          deps.store,
          args.paneKey,
          args.worktreeId,
          null
        )
        if (!owner?.incarnationId || owner.ptyId !== args.id) {
          return null
        }
        expectedIncarnationId = owner.incarnationId
      }
      const provider = connectionId ? sshProviders.get(connectionId) : tryGetProviderForPty(args.id)
      if (!provider) {
        return null
      }
      try {
        if (provider.probePtyLiveness) {
          const verdict = expectedIncarnationId
            ? await provider.probePtyLiveness(args.id, expectedIncarnationId)
            : await provider.probePtyLiveness(args.id)
          if (expectedIncarnationId) {
            const currentOwner = resolvePersistedStablePaneOwner(
              deps.store,
              args.paneKey!,
              args.worktreeId!,
              null
            )
            if (
              currentOwner?.ptyId !== args.id ||
              currentOwner.incarnationId !== expectedIncarnationId
            ) {
              return null
            }
          }
          return verdict
        }
        if (!provider.hasPty || expectedIncarnationId) {
          return null
        }
        return provider.hasPty(args.id)
      } catch {
        return null
      }
    }
  )
}
