import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import {
  isDirectorResolutionFailure,
  persistRelayHost,
  toError
} from './mobile-endpoint-supervisor-support'
import type { HostProfile } from './types'

export type MobileRelayAttemptResult = { ok: true } | { ok: false; error: Error }

export async function retryMobileRelayWithEndpointRefresh(args: {
  host: HostProfile
  resumeToken: string
  resolveRelay: (input: {
    relay: MobileRelayEndpoint
    resumeToken: string
  }) => Promise<MobileRelayEndpoint>
  saveHost: (host: HostProfile) => Promise<void>
  tryRelay: (host: HostProfile) => Promise<MobileRelayAttemptResult>
}): Promise<{ host: HostProfile; result: MobileRelayAttemptResult }> {
  const first = await args.tryRelay(args.host)
  if (first.ok || !isDirectorResolutionFailure(first.error) || !args.host.relay) {
    return { host: args.host, result: first }
  }
  try {
    const resolved = await args.resolveRelay({
      relay: args.host.relay,
      resumeToken: args.resumeToken
    })
    const host = await persistRelayHost(args.host, resolved, args.saveHost)
    return { host, result: await args.tryRelay(host) }
  } catch (error) {
    return { host: args.host, result: { ok: false, error: toError(error) } }
  }
}
