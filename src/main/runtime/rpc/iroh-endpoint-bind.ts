import type { Endpoint } from '@number0/iroh'
import { PAIRING_IROH_DIRECT_ADDRESS_MAX_COUNT } from '../../../shared/remote-runtime/pairing/mobile-pairing-protocol-limits'
import { loadIrohNativeModule, type IrohNativeModule } from './iroh-native-loader'

type IrohModuleLoadReason =
  | 'MODULE_NOT_FOUND'
  | 'ERR_MODULE_NOT_FOUND'
  | 'ERR_DLOPEN_FAILED'
  | 'unsupported-api'
  | 'unknown'

/** Keep permanent SDK failures actionable without retaining potentially sensitive causes. */
export class IrohModuleLoadError extends Error {
  readonly reason: IrohModuleLoadReason

  /** Expose only known import codes or the explicit API compatibility stage. */
  constructor(cause: unknown, stage: 'import' | 'api' = 'import') {
    const code = cause instanceof Error && 'code' in cause ? cause.code : undefined
    const reason =
      stage === 'api'
        ? 'unsupported-api'
        : code === 'MODULE_NOT_FOUND' ||
            code === 'ERR_MODULE_NOT_FOUND' ||
            code === 'ERR_DLOPEN_FAILED'
          ? code
          : 'unknown'
    super(
      `Patched Iroh SDK could not be loaded (${reason}); run pnpm build:orcad-prebuilds, ` +
        'then provision source with node config/scripts/orcad-distribution/prebuilds/stage-source-iroh.mjs ' +
        '(outside the pinned FHS environment), or reinstall the packaged runtime, and restart'
    )
    this.name = 'IrohModuleLoadError'
    this.reason = reason
  }
}

/** Lazily load the SDK and bind the selected relay; return null if already aborted. */
export async function bindIrohEndpoint(
  secretKey: number[],
  alpn: number[],
  relayUrl: string | null,
  signal: AbortSignal
): Promise<Endpoint | null> {
  // Why: the loader imports only Node builtins; the addon itself stays lazy.
  let sdk: IrohNativeModule
  try {
    sdk = loadIrohNativeModule()
  } catch (cause) {
    throw new IrohModuleLoadError(cause)
  }
  let patched = false
  try {
    patched =
      typeof sdk?.Endpoint?.bind === 'function' &&
      typeof sdk?.RelayMode?.customFromUrls === 'function' &&
      typeof sdk?.Accepting?.incomingHandshakeTimeoutMs === 'function' &&
      sdk.Accepting.incomingHandshakeTimeoutMs() === 10_000
  } catch {
    // Native capability failures are permanent too; never retain their potentially private cause.
  }
  if (!patched) {
    throw new IrohModuleLoadError(undefined, 'api')
  }
  if (signal.aborted) {
    return null
  }
  return sdk.Endpoint.bind(
    { secretKey, alpns: [alpn] },
    relayUrl ? sdk.RelayMode.customFromUrls([relayUrl]) : undefined
  )
}

/** Read bounded pairing hints, returning null if the native endpoint is unavailable. */
export function readIrohEndpointDialHints(
  endpoint: Endpoint
): { relayUrl: string | null; directAddresses: string[] } | null {
  try {
    const addr = endpoint.addr()
    return {
      relayUrl: addr.relayUrl() ?? null,
      // Why: cap to keep the QR payload small; iroh ranks LAN addrs first.
      directAddresses: addr.directAddresses().slice(0, PAIRING_IROH_DIRECT_ADDRESS_MAX_COUNT)
    }
  } catch {
    return null
  }
}
