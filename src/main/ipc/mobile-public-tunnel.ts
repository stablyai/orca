import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  idlePublicTunnelState,
  type PublicTunnelError,
  type PublicTunnelState
} from '../../shared/public-tunnel-types'
import {
  buildRemoteWebClientUrl,
  CloudflareTunnelManager
} from '../runtime/tunnel/cloudflare-tunnel-manager'
import { getWebSocketPort } from '../runtime/windows-mobile-firewall'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

const CLOUDFLARED_INSTALL_GUIDANCE =
  'Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and retry, or set ORCA_CLOUDFLARED_PATH to its executable.'

type PublicTunnelOffer = {
  publicUrl: string
  remoteUrl: string
  webClientUrl: string | null
  pairingUrl: string
  deviceId: string
  qrDataUrl: string | null
  qrSize: number | null
}

export type PublicTunnelHandlerDependencies = {
  rpcServer: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
  encodePairingQr: (pairingUrl: string) => Promise<{
    ok: boolean
    qrDataUrl?: string
    qrSize?: number
  }>
  /** Injectable so IPC tests never spawn a real cloudflared. */
  publicTunnelManager?: CloudflareTunnelManager
}

function isWindowRenderer(event: IpcMainInvokeEvent): boolean {
  return event.sender.getType() === 'window'
}

/** Owns the single Cloudflare Quick Tunnel exposed by the desktop Settings page. */
export function registerPublicTunnelHandlers(
  dependencies: PublicTunnelHandlerDependencies
): void {
  const { rpcServer } = dependencies
  let publicTunnelManager: CloudflareTunnelManager
  let publicTunnelOffer: PublicTunnelOffer | null = null
  let publicTunnelError: PublicTunnelError | null = null
  let publicTunnelStatusTarget: WebContents | null = null

  const publicTunnelState = (): PublicTunnelState => {
    const tunnel = publicTunnelManager.getState()
    const base = idlePublicTunnelState()
    if (publicTunnelError) {
      return {
        ...base,
        status: 'error',
        error: publicTunnelError,
        publicUrl: tunnel.publicUrl,
        startedAt: tunnel.startedAt
      }
    }
    if (tunnel.status === 'error') {
      return {
        ...base,
        status: 'error',
        error: {
          code: 'start_failed',
          message: tunnel.error ?? 'The public tunnel stopped unexpectedly.'
        },
        startedAt: tunnel.startedAt
      }
    }
    if (tunnel.status !== 'connected' || !publicTunnelOffer) {
      return {
        ...base,
        status: tunnel.status,
        publicUrl: tunnel.publicUrl,
        startedAt: tunnel.startedAt
      }
    }
    return {
      ...base,
      status: 'connected',
      publicUrl: publicTunnelOffer.publicUrl,
      remoteUrl: publicTunnelOffer.remoteUrl,
      webClientUrl: publicTunnelOffer.webClientUrl,
      pairingUrl: publicTunnelOffer.pairingUrl,
      deviceId: publicTunnelOffer.deviceId,
      qrDataUrl: publicTunnelOffer.qrDataUrl,
      qrSize: publicTunnelOffer.qrSize,
      startedAt: tunnel.startedAt
    }
  }

  const publishPublicTunnelState = (): void => {
    const target = publicTunnelStatusTarget
    if (target && !target.isDestroyed()) {
      target.send('mobile:publicTunnelStatusChanged', publicTunnelState())
    }
  }

  publicTunnelManager =
    dependencies.publicTunnelManager ??
    new CloudflareTunnelManager({ onStateChange: () => publishPublicTunnelState() })

  const failPublicTunnel = (
    code: PublicTunnelError['code'],
    message: string,
    guidance?: string
  ): PublicTunnelState => {
    publicTunnelError = { code, message, ...(guidance ? { guidance } : {}) }
    publishPublicTunnelState()
    return publicTunnelState()
  }

  ipcMain.handle(
    'mobile:startPublicTunnel',
    async (event: IpcMainInvokeEvent, args?: { rotate?: boolean }) => {
      if (!isWindowRenderer(event)) {
        return {
          ...idlePublicTunnelState(),
          status: 'error' as const,
          error: {
            code: 'unsupported' as const,
            message: 'Only the desktop window can start a public tunnel.'
          }
        }
      }
      publicTunnelStatusTarget = event.sender
      publicTunnelError = null
      publicTunnelOffer = null
      const endpoint = rpcServer.getWebSocketEndpoint()
      const port = endpoint ? getWebSocketPort(endpoint) : null
      if (!port) {
        return failPublicTunnel(
          'runtime_unavailable',
          'The runtime WebSocket listener is not running.',
          'Restart Orca and try again.'
        )
      }
      const started = await publicTunnelManager.start({ localPort: port })
      if (!started.ok) {
        const guidance =
          started.reason === 'cloudflared_not_found'
            ? CLOUDFLARED_INSTALL_GUIDANCE
            : started.reason === 'timeout'
              ? 'Check the network connection and retry. A firewall may be blocking outbound HTTPS.'
              : undefined
        return failPublicTunnel(started.reason, started.message, guidance)
      }

      const publicHost = new URL(started.publicUrl).host
      const offer = rpcServer.createPairingOffer({
        address: `wss://${publicHost}`,
        name: `Mobile ${new Date().toLocaleDateString()}`,
        scope: 'runtime',
        // Reuse the pending grant unless the user explicitly asks for a fresh link.
        rotate: args?.rotate ?? false,
        reach: 'network'
      })
      if (!offer.available) {
        await publicTunnelManager.stop()
        return failPublicTunnel(
          'pairing_unavailable',
          offer.guidance,
          'Verify that the Orca data directory is writable and restart the runtime.'
        )
      }

      const remoteUrl = buildRemoteWebClientUrl(started.publicUrl, offer.pairingUrl)
      const qr = await dependencies.encodePairingQr(remoteUrl)
      publicTunnelOffer = {
        publicUrl: started.publicUrl,
        remoteUrl,
        webClientUrl: offer.webClientUrl,
        pairingUrl: offer.pairingUrl,
        deviceId: offer.deviceId,
        qrDataUrl: qr.ok ? (qr.qrDataUrl ?? null) : null,
        qrSize: qr.ok ? (qr.qrSize ?? null) : null
      }
      publishPublicTunnelState()
      return publicTunnelState()
    }
  )

  ipcMain.handle('mobile:stopPublicTunnel', async (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event)) {
      return {
        ...idlePublicTunnelState(),
        status: 'error' as const,
        error: {
          code: 'unsupported' as const,
          message: 'Only the desktop window can stop a public tunnel.'
        }
      }
    }
    publicTunnelStatusTarget = event.sender
    await publicTunnelManager.stop()
    publicTunnelOffer = null
    publicTunnelError = null
    publishPublicTunnelState()
    return publicTunnelState()
  })

  ipcMain.handle('mobile:getPublicTunnelStatus', (event: IpcMainInvokeEvent) => {
    if (isWindowRenderer(event)) {
      publicTunnelStatusTarget = event.sender
    }
    return publicTunnelState()
  })

  app.once?.('will-quit', () => publicTunnelManager.dispose())
}
