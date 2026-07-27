import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import { persistRelayHost } from './mobile-endpoint-supervisor-support'
import type { MobileConnectionPath, StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export async function refreshMobileRelayCredentialIfNeeded(args: {
  force: boolean
  stopped: boolean
  activePath: MobileConnectionPath
  now: number
  client: StableLogicalRpcClient
  bundle: MobileRelayCredentialBundle | null
  host: HostProfile
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  saveHost: (host: HostProfile) => Promise<void>
  randomBytes: (length: number) => Uint8Array
}): Promise<{ bundle: MobileRelayCredentialBundle; host: HostProfile } | null> {
  if (
    args.stopped ||
    !args.bundle ||
    args.activePath === 'relay' ||
    (!args.force && !mobileRelayCredentialNeedsRotation(args.bundle, args.now))
  ) {
    return null
  }
  try {
    const result = await rotateMobileRelayCredential({
      client: args.client,
      bundle: args.bundle,
      writeBundle: args.writeBundle,
      randomBytes: args.randomBytes
    })
    return {
      bundle: result.bundle,
      host: await persistRelayHost(args.host, result.relay, args.saveHost)
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    return null
  }
}
