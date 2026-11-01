import type { MountAdapter, MountContext } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'
import {
  HOST_ID,
  credentialHash,
  INSTALL_REQ_ID,
  PENDING_RESUME_TOKEN,
  credentialBundle,
  directHost
} from '../relay-pairing-fixtures'

// Record request ordering and authoritative install statuses before persistence; lost credential-mutation replies remain unknown.
export function relayCredentialMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'relay.credential-rotation': ({ client, effect }: MountContext) => {
      const rotate = modules.load<
        typeof import('../../../transport/mobile-relay-credential-rotation')
      >('mobile/src/transport/mobile-relay-credential-rotation.ts').rotateMobileRelayCredential
      const hash = credentialHash(modules)
      let bundle = credentialBundle(hash)
      let outcome: unknown = 'unrotated'
      return {
        action(_name, args) {
          const started = rotate({
            client,
            bundle:
              args.pending === true
                ? {
                    ...bundle,
                    pending: {
                      token: PENDING_RESUME_TOKEN,
                      hash: hash(PENDING_RESUME_TOKEN),
                      reqId: INSTALL_REQ_ID
                    }
                  }
                : bundle,
            writeBundle: async (next) => {
              bundle = next
              effect('bundle-written', {
                version: next.current.version,
                pending: next.pending !== undefined,
                grace: next.grace?.expiresAt ?? null
              })
            }
          })
          started.then(
            (result) => {
              outcome = {
                version: result.bundle.current.version,
                relayHostId: result.relay.relayHostId
              }
            },
            (error: unknown) => {
              outcome = `failed: ${error instanceof Error ? error.message : String(error)}`
            }
          )
          return started
        },
        state: () => ({
          outcome,
          version: bundle.current.version,
          pending: bundle.pending !== undefined
        }),
        dispose: () => {}
      }
    },
    'relay.direct-upgrade': ({ client, effect }: MountContext) => {
      const upgrade = modules.load<typeof import('../../../transport/mobile-relay-direct-upgrade')>(
        'mobile/src/transport/mobile-relay-direct-upgrade.ts'
      ).upgradeDirectMobileRelay
      const hash = credentialHash(modules)
      let journal: unknown = null
      let outcome: unknown = 'unupgraded'
      return {
        action(_name, args) {
          if (args.journal === true) {
            journal = {
              v: 1,
              hostId: HOST_ID,
              reqId: INSTALL_REQ_ID,
              pendingResumeToken: PENDING_RESUME_TOKEN,
              pendingResumeTokenHash: hash(PENDING_RESUME_TOKEN)
            }
          }
          const started = upgrade({
            client,
            host: directHost(),
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each mock stands in for the dependency it names; the upgrade defaults the rest.
            dependencies: {
              readJournal: async () => journal,
              writeJournal: async (next: unknown) => {
                journal = next
                effect('journal-written', 'upgrade')
              },
              clearJournal: async () => {
                journal = null
                effect('journal-cleared', 'upgrade')
              },
              writeBundle: async (written: { current: { version: number } }) => {
                effect('bundle-written', { version: written.current.version })
              },
              setRelayRouting: async () => {
                effect('host-saved', HOST_ID)
              },
              deleteBundle: async () => {
                effect('bundle-deleted', HOST_ID)
              }
            } as Parameters<typeof upgrade>[0]['dependencies']
          })
          started.then(
            (result) => {
              outcome = result === null ? 'declined' : result.relay.relayHostId
            },
            (error: unknown) => {
              outcome = `failed: ${error instanceof Error ? error.message : String(error)}`
            }
          )
          return started
        },
        state: () => ({ outcome, journal: journal === null ? null : 'present' }),
        dispose: () => {}
      }
    }
  }
}
