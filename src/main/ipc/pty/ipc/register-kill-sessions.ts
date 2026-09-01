import { getPtyIpc } from '../../pty-host-bindings'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { tryGetProviderForPty } from '../provider/registry'
import { killPtySessions } from './kill-sessions'
import type { IPtyProvider } from '../../../providers/types'

export function installPtyKillSessionsHandler(args: {
  store?: Store
  runtime?: OrcaRuntimeService
  registeredPtyProviders: () => readonly { provider: IPtyProvider; connectionId?: string | null }[]
  getLocalPtyProviderStartupPromise: (connectionId?: string | null) => Promise<void> | undefined
  shutdownProviderAndDetectExit: (
    provider: IPtyProvider,
    id: string,
    opts: { immediate?: boolean; intent?: 'owner-close' | 'orphan-cleanup'; incarnationId?: string }
  ) => Promise<boolean>
  rememberSyntheticKillExit: (id: string) => void
  sendPtyExitToRenderer: (payload: { id: string; code: number; incarnationId?: string }) => void
}): void {
  getPtyIpc().handle(
    'pty:killSessions',
    async (_event, input: { sessions?: unknown; intent?: unknown }) => {
      const refs = Array.isArray(input?.sessions)
        ? input.sessions.filter((value): value is { id: string; incarnationId?: string } => {
            if (!value || typeof value !== 'object') {
              return false
            }
            const candidate = value as { id?: unknown; incarnationId?: unknown }
            return (
              typeof candidate.id === 'string' &&
              candidate.id.length > 0 &&
              (candidate.incarnationId === undefined || typeof candidate.incarnationId === 'string')
            )
          })
        : []
      const intent = input?.intent === 'owner-close' ? 'owner-close' : 'orphan-cleanup'
      const claimed = new Set<string>()
      const ownerInventoryUnavailable = new Set<IPtyProvider>()
      if (intent === 'orphan-cleanup') {
        const snapshots = await Promise.all(
          args.registeredPtyProviders().map(async ({ provider }) => {
            try {
              return { provider, rows: await provider.listProcesses() }
            } catch {
              ownerInventoryUnavailable.add(provider)
              return { provider, rows: [] }
            }
          })
        )
        for (const { rows } of snapshots) {
          for (const row of rows) {
            if (row.agentSessionOwners?.length) {
              claimed.add(row.id)
            }
          }
        }
      }
      return killPtySessions(refs, intent, {
        listProviders: args.registeredPtyProviders,
        providerForSession: tryGetProviderForPty,
        isOwned: (ref) => {
          if (intent === 'owner-close') {
            return { owned: false }
          }
          const surface = args.runtime?.getPtySurfaceOwnershipEvidence(ref.id, ref.incarnationId)
          if (surface !== 'absent') {
            return {
              owned: true,
              reason:
                surface === 'present' ? 'terminal surface ownership' : 'terminal ownership unknown'
            }
          }
          return claimed.has(ref.id)
            ? { owned: true, reason: 'agent ownership claim' }
            : { owned: false }
        },
        shutdown: async (provider, ref) => {
          await args.shutdownProviderAndDetectExit(provider, ref.id, {
            immediate: true,
            intent,
            incarnationId: ref.incarnationId
          })
        },
        singleKill: {
          store: args.store,
          runtime: args.runtime,
          getLocalPtyProviderStartupPromise: args.getLocalPtyProviderStartupPromise,
          rememberSyntheticKillExit: args.rememberSyntheticKillExit,
          sendPtyExitToRenderer: args.sendPtyExitToRenderer
        },
        supportsIncarnationFence: (provider, sessionId) =>
          provider.supportsIncarnationFence?.({ sessionId }) ?? false,
        ownershipUnavailable: (provider) => ownerInventoryUnavailable.has(provider)
      })
    }
  )
}
