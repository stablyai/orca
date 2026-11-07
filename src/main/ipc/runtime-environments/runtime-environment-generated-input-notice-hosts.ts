import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { GeneratedInputNoticeOwner } from '../../runtime/generated-agent-input-notices'
import {
  forwardGeneratedInputNotices,
  type GeneratedInputNoticeHosts
} from '../../runtime/generated-agent-input-notice-forwarder'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { IpcMainInvokeEvent } from 'electron'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { RemoteGeneratedInputIngress } from '../runtime'
import { createRuntimeEnvironmentMobileRelayHosts } from './runtime-environment-mobile-relay-hosts'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentRegistryRoot } from './runtime-environment-registry-root'
import { onRuntimeEnvironmentStatusPublished } from './runtime-environment-status-owner'

/** The host a request is sent to, as its window's record names it: the pairing the request goes
 *  over. Its runtime comes only from the request's own qualified target, never the registry. */
export function generatedInputNoticeOwnerOf(
  environment: KnownRuntimeEnvironment
): GeneratedInputNoticeOwner {
  return {
    environmentId: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt
  }
}

/** The window's request bound for `args.selector`, held before anything about it can refuse or
 *  wait; null when it is not a held request or names no known environment. */
export function acceptRemoteGeneratedInput(
  accept: RemoteGeneratedInputIngress | undefined,
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  args: Parameters<RemoteGeneratedInputIngress>[2] & { selector: string }
): ReturnType<RemoteGeneratedInputIngress> {
  if (!accept) {
    return null
  }
  try {
    const environment = resolveEnvironment(getRuntimeEnvironmentRegistryRoot(), args.selector)
    return accept(event, environment, args)
  } catch {
    // An unknown environment is refused before anything is sent; the window's own copy stays.
    return null
  }
}

/** The paired-host calls, connectivity and retirement signals main already gives the phone relay,
 *  with its no-start preparation; notices add no transport of their own. */
export function createGeneratedInputNoticeHosts(): GeneratedInputNoticeHosts {
  const { call, onEnvironmentRetired } = createRuntimeEnvironmentMobileRelayHosts()
  return {
    call,
    // Names the host whose status changed, so only that host's owed work wakes.
    onStatusChanged: onRuntimeEnvironmentStatusPublished,
    onEnvironmentRetired,
    isManuallyDisconnected: isRuntimeEnvironmentManuallyDisconnected
  }
}

let stopForwarding: (() => void) | null = null

/** The local runtime's one forwarder; handler re-registration replaces it. */
export function forwardGeneratedInputNoticesToHosts(
  runtime: Pick<OrcaRuntimeService, 'generatedInputNotices'>
): void {
  stopForwarding?.()
  stopForwarding = forwardGeneratedInputNotices(
    runtime.generatedInputNotices,
    createGeneratedInputNoticeHosts()
  )
}
