/** ORCA_E2E_FAKE_WSL_HOSTS maps fake distros directly to a headless server pairing so any CI OS can test WSL host UI without wsl.exe. */
import { appendFileSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { parsePairingCode } from '../../shared/pairing'
import type { WslHostConnector } from './wsl-host-service'
import type { WslOrcadConnection, WslOrcadConnectionDependencies } from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId } from './wsl-orcad-deploy'
import {
  stopWslHostServer,
  wslHostRuntimeStopSteps,
  type WslHostRuntimeAccess
} from './wsl-host-server-stop'

const FakeDistrosSchema = z.array(
  z.object({
    name: z.string().min(1),
    state: z.enum(['running', 'stopped']),
    version: z.union([z.literal(1), z.literal(2)])
  })
)

const FakeWslHostsSchema = z.object({
  distros: FakeDistrosSchema,
  /** Re-read on every listing, so a test can register a distro while the app runs. */
  distrosFile: z.string().optional(),
  pairingCode: z.string().min(1),
  /** Each distro the fake is asked to start, one per line, so e2e can prove nothing respawns. */
  connectLogFile: z.string().optional(),
  /** `missing` stands in for a build shipped without the orcad template. */
  serverFiles: z.enum(['present', 'missing']).optional()
})

export function readFakeWslHostsConfig(
  raw = process.env.ORCA_E2E_FAKE_WSL_HOSTS
): z.infer<typeof FakeWslHostsSchema> | null {
  if (!raw) {
    return null
  }
  return FakeWslHostsSchema.parse(JSON.parse(raw))
}

export function createFakeWslHostConnector(
  config: z.infer<typeof FakeWslHostsSchema>,
  onChange: NonNullable<WslOrcadConnectionDependencies['onChange']>,
  options: { isKnownDistro: (distro: string) => boolean; runtime: WslHostRuntimeAccess }
): WslHostConnector {
  const offer = parsePairingCode(config.pairingCode)
  const port = offer ? Number(new URL(offer.endpoint).port) : 0
  const active = new Map<string, WslOrcadConnection>()
  const key = (distro: string): string => distro.toLowerCase()
  return {
    listDistros: async () =>
      (config.distrosFile
        ? FakeDistrosSchema.parse(JSON.parse(readFileSync(config.distrosFile, 'utf8')))
        : config.distros
      ).map((distro, index) => ({
        ...distro,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      })),
    readOrcadPublicKey: async () => null,
    connect: async (distro) => {
      // Same guard as the real connector: nothing starts for a host that is gone.
      if (!options.isKnownDistro(distro)) {
        throw new Error(`${distro} is no longer a WSL host; Orca will not start anything for it.`)
      }
      if (config.connectLogFile) {
        appendFileSync(config.connectLogFile, `${distro}\n`)
      }
      onChange(distro, null, { state: 'connecting' })
      const connection: WslOrcadConnection = {
        distro,
        environmentId: defaultWslOrcadEnvironmentId(distro),
        localPort: port,
        remotePort: port,
        fullVersion: 'e2e',
        pid: null,
        pairingOffer: config.pairingCode,
        deferredUpdate: null,
        close: async () => {
          active.delete(key(distro))
        }
      }
      active.set(key(distro), connection)
      onChange(distro, connection, { state: 'ready', census: null })
      return connection
    },
    get: (distro) => active.get(key(distro)) ?? null,
    isReachable: async (distro) => active.has(key(distro)),
    disconnect: async (distro) => {
      if (active.delete(key(distro))) {
        onChange(distro, null, { state: 'closed' })
      }
    },
    // Use real terminal RPCs against the headless fixture server for removal proof; fake only decommission.
    stopServer: async (distro, environmentId) => {
      if (!active.get(key(distro))) {
        return { stopped: true }
      }
      return stopWslHostServer({
        ...wslHostRuntimeStopSteps(options.runtime, environmentId),
        closeBridge: async () => {
          if (active.delete(key(distro))) {
            onChange(distro, null, { state: 'closed' })
          }
        },
        decommission: async () => ({
          outcome: 'decommissioned',
          version: 'e2e',
          retirement: 'retired'
        })
      })
    },
    releaseHolder: async () => {},
    adoptHolders: async () => {},
    dispose: async () => {
      active.clear()
    }
  }
}
