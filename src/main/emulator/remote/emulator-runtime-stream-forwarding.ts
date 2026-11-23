import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { deriveAvccUrlFromStreamUrl } from '../serve-sim-detached-session'
import { emulatorLoopbackUrlPort } from '../emulator-tunnel-target-policy'
import {
  EMULATOR_TUNNEL_READY_TIMEOUT_MS,
  EmulatorRuntimeTunnelTransport
} from './emulator-runtime-tunnel-transport'
import { EmulatorRuntimePortForwards } from './emulator-runtime-port-forwards'

export type EmulatorRuntimeSessionUrls = {
  streamUrl?: string
  wsUrl?: string
}

type EnvironmentForwarding = {
  transport: EmulatorRuntimeTunnelTransport
  forwards: EmulatorRuntimePortForwards
}

const forwardingByEnvironment = new Map<string, EnvironmentForwarding>()
const forwardedIosStreamUrlByDevice = new Map<string, string>()

function environmentForwarding(userDataPath: string, environmentId: string): EnvironmentForwarding {
  const existing = forwardingByEnvironment.get(environmentId)
  if (existing) {
    return existing
  }
  const transport = new EmulatorRuntimeTunnelTransport(
    `emulator:${environmentId}`,
    async (callbacks, outboundMemory) => {
      await ensureOrcadManagedTunnel(userDataPath, environmentId)
      const connection = getPreferredPairedRuntimeConnection(
        await resolveEnvironment(userDataPath, environmentId)
      )
      return subscribeRemoteRuntimeTransport(
        connection,
        'emulator.tunnel',
        {},
        EMULATOR_TUNNEL_READY_TIMEOUT_MS,
        callbacks,
        {
          perMessageDeflate: false,
          // Same bounds as browser tunnels: a slow relay drops back to flow control, not memory.
          outboundQueue: {
            softCapBytes: 1024 * 1024,
            maxQueuedBytes: 7 * 1024 * 1024,
            maxQueuedFrames: 2_048,
            maxDrainFramesPerTurn: 4
          },
          outboundMemoryBudget: outboundMemory,
          clientCapabilities: [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES]
        }
      )
    }
  )
  const forwarding: EnvironmentForwarding = {
    transport,
    forwards: new EmulatorRuntimePortForwards(
      (target) => transport.open(target),
      () => {
        if (forwardingByEnvironment.get(environmentId) === forwarding) {
          forwardingByEnvironment.delete(environmentId)
          transport.close()
        }
      }
    )
  }
  forwardingByEnvironment.set(environmentId, forwarding)
  return forwarding
}

async function forwardUrl(
  forwards: EmulatorRuntimePortForwards,
  url: string | undefined
): Promise<string | undefined> {
  const remotePort = url ? emulatorLoopbackUrlPort(url) : null
  if (!url || remotePort === null) {
    return undefined
  }
  const forwarded = new URL(url)
  forwarded.hostname = '127.0.0.1'
  forwarded.port = String(await forwards.localPortFor(remotePort))
  return forwarded.toString()
}

/** Rewrites a paired runtime's simulator helper URLs to loopback ports here that tunnel to it. */
export async function forwardEmulatorRuntimeSession(
  userDataPath: string,
  args: { environmentId: string; deviceUdid?: string } & EmulatorRuntimeSessionUrls
): Promise<EmulatorRuntimeSessionUrls> {
  const { forwards } = environmentForwarding(userDataPath, args.environmentId)
  const [streamUrl, wsUrl] = await Promise.all([
    forwardUrl(forwards, args.streamUrl),
    forwardUrl(forwards, args.wsUrl)
  ])
  if (args.deviceUdid && streamUrl) {
    forwardedIosStreamUrlByDevice.set(args.deviceUdid, streamUrl)
  }
  return { streamUrl, wsUrl }
}

/** AVCC URL for a forwarded runtime session, so renderers still name only a device. */
export function getForwardedIosVideoStreamUrl(deviceUdid: string): string | null {
  const streamUrl = forwardedIosStreamUrlByDevice.get(deviceUdid)
  return streamUrl ? (deriveAvccUrlFromStreamUrl(streamUrl) ?? null) : null
}
