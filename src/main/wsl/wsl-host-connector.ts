import { createWslOrcadPairingRecovery } from './wsl-orcad-pairing-repair'
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { parsePairingCode } from '../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { verifyOrcadPairingIdentity } from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { resolveEnvironmentPairingOffer } from '../../shared/runtime-environment-store'
import { findWslHostDeployment } from '../../shared/runtime-environment-wsl-host-store'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { listWslHostDistros } from './wsl-host-distro-list'
import { resolveWslDistroName } from './wsl-distro-registry-id'
import type { WslHostConnector, WslHostReachability } from './wsl-host-service'
import { readWslDistroOrcadPublicKey } from './wsl-host-ssh-orcad-conflict'
import {
  WslOrcadConnectionManager,
  type WslOrcadConnection,
  type WslOrcadConnectionDependencies
} from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId, deployAndLaunchWslOrcad } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import {
  decommissionWslHostOrcad,
  stopWslHostServer,
  wslHostRuntimeStopSteps,
  type WslHostRuntimeAccess
} from './wsl-host-server-stop'
import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'
import type { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'
import { confirmsRunning } from './wsl-orcad-liveness-evidence'
import { wslDistroHolderKey } from './wsl-distro-holder-record'

function targetFor(distro: string): WslOrcadHostTarget {
  return { kind: 'wsl', id: defaultWslOrcadEnvironmentId(distro), distro, label: distro }
}

function transportFor(distro: string) {
  return createWslOrcadHostTransport({ target: targetFor(distro) })
}

type Reachability = WslHostReachability

export function createWslHostConnector(options: {
  userDataPath: string
  onChange: NonNullable<WslOrcadConnectionDependencies['onChange']>
  hasUserVisibleWork: (distro: string) => boolean
  /** False once a distro's host is gone: nothing may be spawned for it again. */
  isKnownDistro: (distro: string) => boolean
  runtime: WslHostRuntimeAccess
}): WslHostConnector {
  const refuseUnknown = (distro: string): Error =>
    new Error(`${distro} is no longer a WSL host; Orca will not start anything for it.`)
  // Assigned below; a holder exit cannot arrive before the first ensure.
  let supervisor: WslOrcadLivenessSupervisor | null = null
  const unguardedHolder = createWslDistroHolder({
    userDataPath: options.userDataPath,
    onHolderExit: (distro, exit) => supervisor?.noteHolderExit(distro, exit)
  })
  // Guard here because liveness recovery and deploy can bypass the service.
  const holder: WslDistroHolder = {
    ...unguardedHolder,
    ensureHeld: (distro) =>
      options.isKnownDistro(distro)
        ? unguardedHolder.ensureHeld(distro)
        : Promise.reject(refuseUnknown(distro))
  }
  const pairingRecovery = createWslOrcadPairingRecovery(options.userDataPath)
  const manager = new WslOrcadConnectionManager({
    holder,
    pairingRecovery,
    getPairingOffer: (environmentId) =>
      findWslHostDeployment(options.userDataPath, environmentId)
        ? resolveEnvironmentPairingOffer(options.userDataPath, environmentId)
        : null,
    recordedLocalPort: (environmentId) =>
      findWslHostDeployment(options.userDataPath, environmentId)?.localPort ?? null,
    onChange: options.onChange,
    deployAndLaunch: (distro, deployOptions) =>
      options.isKnownDistro(distro)
        ? deployAndLaunchWslOrcad(distro, deployOptions)
        : Promise.reject(refuseUnknown(distro))
  })
  const liveness = createWslOrcadLivenessSupervisor({
    manager,
    holder,
    hasUserVisibleWork: options.hasUserVisibleWork
  })
  supervisor = liveness
  // Read right before a no-boot reconnect spawns anything in the distro (E9).
  const requireRunning = async (distro: string): Promise<boolean> =>
    confirmsRunning(await readConfirmedRunningWslDistros(), wslDistroHolderKey(distro))
  const coldProbes = new Map<
    string,
    {
      connection: WslOrcadConnection | null
      pairingOffer: string | undefined
      result: Promise<Reachability>
    }
  >()
  const probe = async (
    distro: string,
    environmentId: string,
    connection: WslOrcadConnection | null
  ): Promise<Reachability> => {
    // Bridge dialing spawns wsl.exe; passive checks must first prove the distro runs.
    const running = await readConfirmedRunningWslDistros()
    if (running.status === 'unavailable') {
      return 'unavailable'
    }
    if (!confirmsRunning(running, wslDistroHolderKey(distro))) {
      return 'stopped'
    }
    if (!options.isKnownDistro(distro) || manager.get(distro) !== connection) {
      return 'unreachable'
    }
    if (options.runtime.isReady?.(environmentId)) {
      return 'available'
    }
    if (!connection) {
      return 'unreachable'
    }
    const offer = parsePairingCode(connection.pairingOffer)
    if (!offer) {
      return 'unreachable'
    }
    const identity = await verifyOrcadPairingIdentity(pairedRuntimeConnectionFromOffer(offer), {
      runtimeId: null
    })
    return identity.verdict === 'verified' && manager.get(distro) === connection
      ? 'available'
      : 'unreachable'
  }
  const coldReachability = (distro: string, environmentId: string): Promise<Reachability> => {
    const key = `${wslDistroHolderKey(distro)}\0${environmentId}`
    const connection = manager.get(distro)
    const pairingOffer = connection?.pairingOffer
    const pending = coldProbes.get(key)
    if (pending && pending.connection === connection && pending.pairingOffer === pairingOffer) {
      return pending.result
    }
    const result = probe(distro, environmentId, connection).finally(() => {
      if (coldProbes.get(key)?.result === result) {
        coldProbes.delete(key)
      }
    })
    coldProbes.set(key, { connection, pairingOffer, result })
    return result
  }
  return {
    listDistros: () => listWslHostDistros(),
    readOrcadPublicKey: (distro) => readWslDistroOrcadPublicKey(transportFor(distro)),
    connect: (distro, { noBoot, ...connectOptions } = {}) =>
      liveness.connect(distro, noBoot ? { ...connectOptions, requireRunning } : connectOptions),
    forgetPairingFailures: (environmentId) => pairingRecovery.repairs.forgetFailures(environmentId),
    get: (distro) => manager.get(distro),
    isReachable: async (distro, environmentId) =>
      options.runtime.isReady?.(environmentId) ||
      (await coldReachability(distro, environmentId)) === 'available',
    isSettling: (distro) => liveness.isSettling(distro),
    reachability: async (distro, environmentId) =>
      options.runtime.isReady?.(environmentId)
        ? 'available'
        : coldReachability(distro, environmentId),
    disconnect: (distro) => liveness.stop(distro),
    stopServer: async (distro, environmentId) => {
      const reachability = await coldReachability(distro, environmentId)
      if (reachability === 'unavailable') {
        return {
          stopped: false,
          reason: 'The WSL service did not confirm whether the distro runs.',
          verdict: 'unverifiable'
        }
      }
      if (reachability === 'stopped') {
        return { stopped: true }
      }
      if (reachability === 'unreachable') {
        await liveness.connect(distro)
      }
      const target = targetFor(distro)
      return stopWslHostServer({
        ...wslHostRuntimeStopSteps(options.runtime, environmentId),
        closeBridge: () => liveness.stop(distro),
        decommission: decommissionWslHostOrcad(target, createWslOrcadHostTransport({ target }))
      })
    },
    resolveDistroName: (distro, distroId) => resolveWslDistroName(distro, distroId),
    releaseHolder: async (distro) => {
      await holder.release(distro)
    },
    adoptHolders: async (isWanted) => {
      for (const { distro } of await holder.adoptHolders()) {
        if (!isWanted(distro)) {
          // Verified by pid, start time and command line; an unverifiable holder is kept.
          await holder.release(distro)
        }
      }
    },
    dispose: () => liveness.dispose()
  }
}
