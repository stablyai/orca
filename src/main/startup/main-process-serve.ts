import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { notifyServeSupervisorReady } from '../serve-update-handoff'
import { mainProcessState as state } from './main-process-state'
import { getServeOptions, type ServeOptions } from './serve-options'

export { getServeOptions, type ServeOptions }

export function getBundledWebClientRoot(): string | undefined {
  const appPath = app.getAppPath()
  const roots = [
    join(appPath, 'out', 'web'),
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the web bundle.
    join(appPath, '..', 'web')
  ]
  return roots.find((root) => existsSync(join(root, 'web-index.html')))
}

async function renderTerminalPairingQr(pairingUrl: string): Promise<string | null> {
  // Why dynamic: qrcode is only reachable from mobile pairing, so launch should
  // not parse it for the majority who never pair a device.
  const QRCode = await import('qrcode')
  try {
    return await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
  } catch {
    try {
      return await QRCode.toString(pairingUrl, { type: 'utf8' })
    } catch {
      return null
    }
  }
}

export async function printServeReady(options: ServeOptions): Promise<void> {
  const runtime = state.runtime
  const runtimeRpc = state.runtimeRpc
  if (!runtime || !runtimeRpc) {
    throw new Error('Runtime server must be initialized before printing serve readiness')
  }
  if (options.recipeJson) {
    if (!options.projectRoot) {
      throw new Error('--serve-recipe-json requires --serve-project-root')
    }
    if (!isAbsolute(options.projectRoot)) {
      throw new Error(`--serve-project-root must be absolute: ${options.projectRoot}`)
    }
    if (!statSync(options.projectRoot).isDirectory()) {
      throw new Error(`--serve-project-root must be a directory: ${options.projectRoot}`)
    }
  }
  const boundEndpoint = runtimeRpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const pairing = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : runtimeRpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope: options.mobilePairing ? 'mobile' : 'runtime'
      })
  const pairingQr =
    pairing.available && options.mobilePairing
      ? await renderTerminalPairingQr(pairing.pairingUrl)
      : null
  await state.serveReadinessPublisher.publish(
    {
      runtimeId: runtime.getRuntimeId(),
      boundEndpoint,
      advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
      // Why: the WSL reconciliation barrier fails open, so 'pending' warns a WSL PTY launch may still race a repair.
      managedWslCliReconciliation: state.managedWslCliReconciliationStatus,
      pairing: pairing.available
        ? {
            available: true,
            url: pairing.pairingUrl,
            endpoint: pairing.endpoint,
            deviceId: pairing.deviceId,
            webClientUrl: pairing.webClientUrl,
            scope: options.mobilePairing ? 'mobile' : 'runtime',
            qr: pairingQr
          }
        : pairing
    },
    options.recipeJson
      ? { mode: 'recipe-json', projectRoot: options.projectRoot! }
      : { mode: options.json ? 'json' : 'human' }
  )
  notifyServeSupervisorReady(runtime.getRuntimeId())
}
