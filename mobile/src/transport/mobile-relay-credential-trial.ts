import {
  isDirectorResolutionFailure,
  persistRelayHost,
  toError
} from './mobile-endpoint-supervisor-support'
import type { HostProfile } from './types'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'

export type TryRelayCredentialResult = { ok: true } | { ok: false; error: Error }

export async function tryRelayCredential(args: {
  credential: { token: string; version: number }
  host: HostProfile
  logicalState: () => string
  logicalActivePath: () => string
  openAndMigrateRelay: (credential: {
    token: string
    version: number
  }) => Promise<{ ok: true } | { ok: false; error: Error }>
  resolveRelay: (args: {
    relay: MobileRelayEndpoint
    resumeToken: string
  }) => Promise<MobileRelayEndpoint>
  saveHost: (host: HostProfile) => Promise<void>
  updateHost: (host: HostProfile) => void
}): Promise<TryRelayCredentialResult> {
  const first = await args.openAndMigrateRelay(args.credential)
  if (first.ok) {
    return first
  }
  // Why: if the active session connected on a non-relay path during the
  // first attempt, the director resolution retry would also race — skip it.
  if (args.logicalState() === 'connected' && args.logicalActivePath() !== 'relay') {
    return first
  }
  if (!isDirectorResolutionFailure(first.error) || !args.host.relay) {
    return first
  }
  try {
    const resolved = await args.resolveRelay({
      relay: args.host.relay,
      resumeToken: args.credential.token
    })
    const host = await persistRelayHost(args.host, resolved, args.saveHost)
    args.updateHost(host)
    return await args.openAndMigrateRelay(args.credential)
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}
