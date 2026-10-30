import { WslOrcadBridgeActivity, wslHostBridgeEvents } from './wsl-orcad-bridge-activity'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'
import { createWslOrcadPairingRecovery } from './wsl-orcad-pairing-repair'
import {
  readSettledConfirmedRunningWslDistros,
  wasWslDistroLastSeenRunningSettled
} from '../wsl-background-distro-gate'
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
import { wslHostServerStopReason } from '../../shared/wsl-host-failure-copy'

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
    ensureHeld: (distro, ensureOptions) =>
      options.isKnownDistro(distro)
        ? unguardedHolder.ensureHeld(distro, ensureOptions)
        : Promise.reject(refuseUnknown(distro))
  }
  const pairingRecovery = createWslOrcadPairingRecovery(options.userDataPath)
  // The desktop's own bridged sockets double as the liveness watch; no bridge is held for it.
  const bridgeActivity = new WslOrcadBridgeActivity()
  const manager = new WslOrcadConnectionManager({
    holder,
    listen: (transport, listenOptions) =>
      listenWslOrcadStdioBridge(transport, {
        ...listenOptions,
        events: wslHostBridgeEvents(bridgeActivity, listenOptions)
      }),
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
    bridgeActivity,
    holder,
    hasUserVisibleWork: options.hasUserVisibleWork
  })
  supervisor = liveness
  // Liveness connects in flight, per distro; a plain connect meanwhile joins rather than re-arms.
  const livenessConnects = new Map<
    string,
    { promise: Promise<WslOrcadConnection>; noBoot: boolean; intent: boolean }
  >()
  // Read right before a no-boot reconnect spawns anything in the distro (E9); settled, since a
  // list taken while the distro stops still names it.
  const requireRunning = async (distro: string): Promise<boolean> =>
    confirmsRunning(await readSettledConfirmedRunningWslDistros(distro), wslDistroHolderKey(distro))
  // A ready client can outlive its distro by a moment; only a settled running read lets it skip
  // the cold check, which never dials a stopped distro (E9). Reads the cache: no probe per call.
  const readyWhileRunning = (distro: string, environmentId: string): boolean =>
    Boolean(options.runtime.isReady?.(environmentId)) && wasWslDistroLastSeenRunningSettled(distro)
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
    const running = await readSettledConfirmedRunningWslDistros(distro)
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
    connect: (distro, { noBoot, ...connectOptions } = {}) => {
      const options = noBoot ? { ...connectOptions, requireRunning } : connectOptions
      const key = wslDistroHolderKey(distro)
      const pending = livenessConnects.get(key)
      // Why join: a second plain connect re-armed the liveness watch (an identity read and a watch
      // channel) and waited for it, which held a pane's first call about 1 s after ready. Never
      // join an Update/Force (its incumbent is on its way out) or, when booting, a no-boot one
      // (it may refuse, and nothing would arm).
      if (pending && !pending.intent && !options.intent && (noBoot || !pending.noBoot)) {
        // While the bridge connect runs, `get` names the server it replaces: wait for the new one.
        return manager.isConnecting(distro)
          ? manager.ensure(distro, options)
          : Promise.resolve(manager.get(distro) ?? manager.ensure(distro, options))
      }
      const connected = liveness.connect(distro, options).finally(() => {
        if (livenessConnects.get(key)?.promise === connected) {
          livenessConnects.delete(key)
        }
      })
      livenessConnects.set(key, {
        promise: connected,
        noBoot: Boolean(noBoot),
        intent: Boolean(options.intent)
      })
      return connected
    },
    forgetPairingFailures: (environmentId) => pairingRecovery.repairs.forgetFailures(environmentId),
    get: (distro) => manager.get(distro),
    isReachable: async (distro, environmentId) =>
      readyWhileRunning(distro, environmentId) ||
      (await coldReachability(distro, environmentId)) === 'available',
    isSettling: (distro) => liveness.isSettling(distro),
    reachability: async (distro, environmentId) =>
      readyWhileRunning(distro, environmentId)
        ? 'available'
        : coldReachability(distro, environmentId),
    disconnect: (distro) => liveness.stop(distro),
    stopServer: async (distro, environmentId) => {
      const reachability = await coldReachability(distro, environmentId)
      if (reachability === 'unavailable') {
        return {
          stopped: false,
          ...wslHostServerStopReason('serviceUnconfirmed'),
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
