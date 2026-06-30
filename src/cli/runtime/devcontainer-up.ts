import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { upsertEnvironmentFromPairingCode } from './environments'
import {
  readContainerNetworkAndIp,
  spawnBridgeContainer,
  spawnDevcontainerServe,
  stopBridgeContainer,
  stopServeContainer,
  waitForBridgeReady
} from './devcontainer-docker-launch'
import { waitForChildExit, waitForOrcaServerReady } from './devcontainer-server-readiness'

export type DevcontainerUpOptions = {
  userDataPath: string
  name: string
  container: string
  hostPort: number
  containerPort: number
  orcaBin: string
  bridgeName: string
  now?: number
}

export type DevcontainerUpSession = {
  ready: Promise<KnownRuntimeEnvironment>
  done: Promise<void>
}

export function startDevcontainerUp(options: DevcontainerUpOptions): DevcontainerUpSession {
  const readyState = createDeferred<KnownRuntimeEnvironment>()
  const doneState = createDeferred<void>()
  let readySettled = false
  let bridgeChild: ReturnType<typeof spawnBridgeContainer> | null = null
  let serveChild: ReturnType<typeof spawnDevcontainerServe> | null = null

  void (async () => {
    try {
      const { networkName, containerIp } = await readContainerNetworkAndIp(options.container)
      bridgeChild = spawnBridgeContainer({
        bridgeName: options.bridgeName,
        networkName,
        containerIp,
        hostPort: options.hostPort,
        containerPort: options.containerPort
      })
      serveChild = spawnDevcontainerServe({
        container: options.container,
        containerPort: options.containerPort,
        hostPort: options.hostPort,
        orcaBin: options.orcaBin
      })
      const [readyPayload] = await Promise.all([
        waitForOrcaServerReady(serveChild),
        waitForBridgeReady(bridgeChild, options.bridgeName, options.hostPort)
      ])
      const readyEnvironment = upsertEnvironmentFromPairingCode(options.userDataPath, {
        name: options.name,
        pairingCode: readyPayload.pairing.url,
        runtimeId: readyPayload.runtimeId,
        now: options.now
      })
      readySettled = true
      readyState.resolve(readyEnvironment)
      await waitForChildExit(serveChild)
      doneState.resolve()
    } catch (error) {
      stopServeContainer(serveChild)
      if (!readySettled) {
        readyState.reject(error)
      }
      doneState.reject(error)
    } finally {
      stopBridgeContainer(bridgeChild)
    }
  })()

  return { ready: readyState.promise, done: doneState.promise }
}

function createDeferred<TResult>(): {
  promise: Promise<TResult>
  resolve: (value: TResult | PromiseLike<TResult>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: TResult | PromiseLike<TResult>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<TResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
