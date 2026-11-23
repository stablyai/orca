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
// Issued stream URL -> where it forwards; a renderer can only name a stream main handed out.
const issuedStreamUrls = new Map<
  string,
  { forwards: EmulatorRuntimePortForwards; remotePort: number }
>()

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
    forwards: new EmulatorRuntimePortForwards((target) => transport.open(target))
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
  const issued = forwarded.toString()
  issuedStreamUrls.set(issued, { forwards, remotePort })
  return issued
}

/** Rewrites a paired runtime's simulator helper URLs to loopback ports here that tunnel to it. */
export async function forwardEmulatorRuntimeSession(
  userDataPath: string,
  args: { environmentId: string } & EmulatorRuntimeSessionUrls
): Promise<EmulatorRuntimeSessionUrls> {
  const { forwards } = environmentForwarding(userDataPath, args.environmentId)
  const [streamUrl, wsUrl] = await Promise.all([
    forwardUrl(forwards, args.streamUrl),
    forwardUrl(forwards, args.wsUrl)
  ])
  return { streamUrl, wsUrl }
}

/**
 * AVCC URL for a stream URL this process forwarded and still serves. Keyed by the issued URL, not
 * the device, so same-UDID devices on two runtimes (or here) never share a stream.
 */
function forwardedIosVideoStreamUrl(streamUrl: string | undefined): string | null {
  const issued = streamUrl ? issuedStreamUrls.get(streamUrl) : undefined
  if (!streamUrl || !issued) {
    return null
  }
  if (!issued.forwards.isLive(issued.remotePort, Number(new URL(streamUrl).port))) {
    issuedStreamUrls.delete(streamUrl)
    return null
  }
  return deriveAvccUrlFromStreamUrl(streamUrl) ?? null
}

/**
 * The AVCC URL for a renderer's video stream: a forwarded runtime stream it was given, else this
 * host's own session for the device, but only when the renderer named that session's stream.
 */
export function resolveIosVideoStreamUrl(
  streamUrl: string | undefined,
  localAvccUrl: string | null | undefined
): string | null {
  const forwarded = forwardedIosVideoStreamUrl(streamUrl)
  if (forwarded) {
    return forwarded
  }
  if (!localAvccUrl) {
    return null
  }
  return !streamUrl || deriveAvccUrlFromStreamUrl(streamUrl) === localAvccUrl ? localAvccUrl : null
}

/** Re-pairing keeps the environment id; drop its tunnel and forwards so new ones use the new peer. */
export function retireEmulatorRuntimeStreamForwarding(environmentId: string): void {
  const forwarding = forwardingByEnvironment.get(environmentId)
  if (!forwarding) {
    return
  }
  forwardingByEnvironment.delete(environmentId)
  for (const [url, issued] of issuedStreamUrls) {
    if (issued.forwards === forwarding.forwards) {
      issuedStreamUrls.delete(url)
    }
  }
  forwarding.forwards.close()
  forwarding.transport.close(new Error('Runtime environment transport was invalidated'))
}
