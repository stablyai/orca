import type { MobileRelayPairingJournal } from '../../../transport/mobile-relay-pairing-journal'
import type { MountAdapter, MountContext } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'
import {
  HOST_ID,
  credentialHash,
  JOURNAL_ID,
  candidateClient,
  pairingJournal,
  pairingOffer,
  pairingRelay
} from '../relay-pairing-fixtures'

/**
 * The two senders that run before a host profile exists: first pairing, and the startup recovery
 * that reconciles a journal a crash or a lost reply left behind. Both race or retry candidates and
 * advance only on an authoritative install status, which is what the recordings have to show.
 */
export function pairingJournalMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'relay.pairing-recovery': ({ client, effect }: MountContext) => {
      const recovery = modules.load<
        typeof import('../../../transport/mobile-relay-pairing-recovery')
      >('mobile/src/transport/mobile-relay-pairing-recovery.ts')
      let journal: MobileRelayPairingJournal | null = pairingJournal(credentialHash(modules))
      let outcome: unknown = 'unrecovered'
      return {
        action(_name, args) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter supplies each injected dependency recovery calls.
          const started = recovery.recoverMobileRelayPairing({
            loadJournal: async () => journal,
            updateJournal: async (
              _id: string,
              update: (metadata: MobileRelayPairingJournal['metadata']) => unknown
            ) => {
              if (journal) {
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store persists the metadata its caller just derived.
                const metadata = update(journal.metadata) as MobileRelayPairingJournal['metadata']
                journal = { ...journal, metadata }
              }
              effect('journal-updated', journal?.metadata.authorizationMode ?? null)
            },
            clearJournal: async () => {
              journal = null
              effect('journal-cleared', 'recovery')
            },
            readCredentialBundle: async () => null,
            writeCredentialBundle: async (written: { current: { version: number } }) => {
              effect('bundle-written', { version: written.current.version })
            },
            loadHosts: async () => [],
            saveHost: async () => {
              effect('host-saved', HOST_ID)
            },
            connectRelay: () => candidateClient(client, effect, 'relay'),
            resolveInviteDirector: async () => pairingRelay(),
            now: () => Date.now() + Number(args.clockSkewMs ?? 0),
            platform: 'ios'
          } as Parameters<typeof recovery.recoverMobileRelayPairing>[0])
          started.then(
            (result: unknown) => {
              outcome = result
            },
            (error: unknown) => {
              outcome = `failed: ${error instanceof Error ? error.message : String(error)}`
            }
          )
          return started
        },
        state: () => ({ outcome, winner: journal?.metadata.winner ?? null }),
        dispose: () => recovery.resetMobileRelayPairingRecoveryForTests()
      }
    },
    'pairing.pre-profile': ({ client, effect }: MountContext) => {
      const start = modules.load<
        typeof import('../../../transport/pre-profile-pairing-coordinator')
      >('mobile/src/transport/pre-profile-pairing-coordinator.ts').startPreProfilePairing
      let outcome: unknown = 'unpaired'
      let attempt: ReturnType<typeof start> | null = null
      let savedHost: unknown = null
      return {
        action(name, args) {
          if (name === 'dispose') {
            attempt?.dispose()
            return
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture offer and dependencies carry the members the coordinator reads.
          attempt = start({
            offer: args.relay === false ? { ...pairingOffer(), relay: undefined } : pairingOffer(),
            timeoutMs: Number(args.timeoutMs ?? 30_000),
            dependencies: {
              connectDirect: () => candidateClient(client, effect, 'direct'),
              connectRelay: () => candidateClient(client, effect, 'relay'),
              resolveInviteDirector: async () => pairingRelay(),
              resolveHostIdentity: async () => ({ id: HOST_ID, name: 'Fixture host' }),
              saveHost: async (host: { relayHostId?: string }) => {
                savedHost = host.relayHostId ?? 'direct-only'
                effect('host-saved', savedHost)
              },
              saveJournal: async () => {
                effect('journal-saved', JOURNAL_ID)
              },
              updateJournal: async () => {
                effect('journal-updated', JOURNAL_ID)
              },
              clearJournal: async () => {
                effect('journal-cleared', JOURNAL_ID)
              },
              writeCredentialBundle: async (written: { current: { version: number } }) => {
                effect('bundle-written', { version: written.current.version })
              },
              platform: 'ios'
            }
          } as Parameters<typeof start>[0])
          attempt.result.then(
            (result) => {
              outcome = result.hostId
            },
            (error: unknown) => {
              outcome = `failed: ${error instanceof Error ? error.message : String(error)}`
            }
          )
          return attempt.result
        },
        state: () => ({ outcome, savedHost, timedOut: attempt?.timedOut ?? null }),
        dispose: () => attempt?.dispose()
      }
    }
  }
}
