import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { applyResumeConfirmation } from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { encodeBase64Url, toError } from './mobile-endpoint-supervisor-support'
import {
  LogicalClientAuthenticationError,
  type StableLogicalRpcClient
} from './stable-logical-rpc-client'

type RelayCredential = { token: string; version: number }

export type MobileRelayRouteConnectionResult =
  | { ok: true; bundle: MobileRelayCredentialBundle; session: MobileRelayRpcSession }
  | { ok: false; error: Error; authenticationFailed: boolean }

export function releaseInactiveMobileRelayRoute(args: {
  logical: StableLogicalRpcClient
  stopped: boolean
  foreground: boolean
}): boolean {
  if (!args.stopped && args.foreground) {
    return false
  }
  // Why: backgrounding can race a successful Relay migration; release the
  // late splice immediately instead of leaving a billed session active.
  if (args.logical.getActivePath() === 'relay') {
    args.logical.suspendActiveSession()
  }
  return true
}

export async function keepMobileRelayRouteActive(args: {
  result: Extract<MobileRelayRouteConnectionResult, { ok: true }>
  logical: StableLogicalRpcClient
  isStopped: () => boolean
  isForeground: () => boolean
  recordLastGood: () => Promise<void>
  scheduleLease: (session: MobileRelayRpcSession) => void
}): Promise<MobileRelayRouteConnectionResult> {
  const inactive = (): MobileRelayRouteConnectionResult => ({
    ok: false,
    error: new Error('relay route became inactive'),
    authenticationFailed: false
  })
  const releaseIfInactive = (): boolean =>
    releaseInactiveMobileRelayRoute({
      logical: args.logical,
      stopped: args.isStopped(),
      foreground: args.isForeground()
    })
  if (releaseIfInactive()) {
    return inactive()
  }
  await args.recordLastGood()
  if (releaseIfInactive()) {
    return inactive()
  }
  args.scheduleLease(args.result.session)
  return args.result
}

export async function openMobileRelayRoute(args: {
  relay: MobileRelayEndpoint
  bundle: MobileRelayCredentialBundle
  credential: RelayCredential
  timeoutMs: number
  logical: StableLogicalRpcClient
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: RelayCredential,
    confirmReqId: string
  ) => MobileRelayRpcSession
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  randomBytes: (length: number) => Uint8Array
}): Promise<MobileRelayRouteConnectionResult> {
  let session: MobileRelayRpcSession
  try {
    session = args.openRelay(
      args.relay,
      args.credential,
      `confirm-${encodeBase64Url(args.randomBytes(16))}`
    )
  } catch (error) {
    return { ok: false, error: toError(error), authenticationFailed: false }
  }
  try {
    await args.logical.migrateTo(session, 'relay', args.timeoutMs)
    let bundle = args.bundle
    const confirmation = session.getResumeConfirmation()
    if (confirmation) {
      bundle = applyResumeConfirmation(bundle, args.credential.version, confirmation)
      // Why: persistence failure must not discard an already authenticated route.
      await args.writeBundle(bundle).catch(() => {})
    }
    return { ok: true, bundle, session }
  } catch (error) {
    const authenticationFailed = error instanceof LogicalClientAuthenticationError
    return {
      ok: false,
      error: session.getFailure() ?? toError(error),
      authenticationFailed
    }
  }
}
