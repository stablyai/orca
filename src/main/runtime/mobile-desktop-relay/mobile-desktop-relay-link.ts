import type { RemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  PHONE_RELAY_OPEN_BUDGET_MS,
  RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
  RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE,
  RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE,
  RUNTIME_ENVIRONMENT_WAKING_MESSAGE,
  recipeVmWakeIntentFor
} from '../../../shared/remote-runtime/recipe-vm-wake'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { RelayedPhoneReplies } from './relayed-phone-frames'

export type OpenedRelayLink = {
  socket: RemoteRuntimePassthroughSocket
  hostToken: string
  host: MobileDesktopRelayHost
}

export type RelayedPhone = {
  connectionId: string
  deviceId: string
  deviceToken: string
  clientCapabilities: () => readonly RuntimeCapability[]
  reply: (frame: string) => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
}

export class RelayLink {
  readonly abortController = new AbortController()
  readonly replies: RelayedPhoneReplies
  readonly opened: Promise<OpenedRelayLink>

  constructor(
    readonly environmentId: string,
    readonly phone: RelayedPhone,
    allocateStreamId: () => number,
    open: (link: RelayLink) => Promise<OpenedRelayLink>
  ) {
    this.replies = new RelayedPhoneReplies(allocateStreamId)
    this.opened = open(this)
  }

  /** Whether this link's preparation has returned, fixing the pairing it opens on: a re-pair after
   *  that retires it. Before it, a recipe VM wake this link's request asked for may re-pair the
   *  server, and the link opens on the new pairing. */
  paired = false
  /** Whether this link is preparing for a request that opens a workspace. */
  private preparingOpen = false
  private retiredWhilePreparing = false
  /** One deadline for the whole open, from the link's first request: preparation (with any hold),
   *  grant sync and the socket. */
  readonly setup = relaySetupDeadline(PHONE_RELAY_OPEN_BUDGET_MS)

  /** Its server was retired (re-paired, removed, disconnected). A paired link ends now; one still
   *  preparing may be waiting on a wake that re-pairs the server, and decides once its
   *  preparation returns (see `prepare`). */
  retire(end: () => void): void {
    // Only a preparation for an open can be waiting on a wake that re-pairs the server.
    if (this.paired || !this.preparingOpen) {
      end()
    } else {
      this.retiredWhilePreparing = true
    }
  }

  async prepare(
    hosts: Pick<MobileDesktopRelayHosts, 'resolve' | 'userDisconnects'>,
    openingMethod: string
  ): Promise<MobileDesktopRelayHost | null> {
    this.preparingOpen = recipeVmWakeIntentFor(openingMethod) === 'wake'
    const disconnects = hosts.userDisconnects?.(this.environmentId)
    // An ended link (its phone gone) stops waiting on a VM wake.
    const host = await hosts.resolve(this.environmentId, openingMethod, this.abortController.signal)
    // Retired while preparing: only the re-pair this link's own open woke is allowed through.
    if (this.retiredWhilePreparing && !host?.wokenByOpening) {
      throw unavailable('The server connection was reset.')
    }
    // A retirement while preparing was skipped (see `paired`); a user's Disconnect still holds,
    // even if the wake's own connect reconnected the server since.
    if (hosts.userDisconnects?.(this.environmentId) !== disconnects) {
      throw unavailable('The server was disconnected on this computer.')
    }
    this.paired = true
    return host
  }

  /** Whether this link may carry a request. One that opens a workspace while the recipe VM behind
   *  this link's server is waking or asleep must not: that server is going or gone. The link then
   *  ends, and the open gets a fresh link whose preparation holds it until the VM is up. */
  carries(
    method: string,
    hosts: Pick<MobileDesktopRelayHosts, 'serverStateForOpening'>,
    end: (refusal: RemoteRuntimeClientError) => void
  ): boolean {
    // A link still preparing for an open is the one this open would get, so it joins that wait.
    if (recipeVmWakeIntentFor(method) !== 'wake' || (!this.paired && this.preparingOpen)) {
      return true
    }
    // Any other link carries it only while the VM behind its server is up.
    const state = hosts.serverStateForOpening?.(this.environmentId) ?? 'up'
    if (state === 'up') {
      return true
    }
    end(
      state === 'waking'
        ? new RemoteRuntimeClientError(
            RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE,
            RUNTIME_ENVIRONMENT_WAKING_MESSAGE
          )
        : new RemoteRuntimeClientError(
            RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
            RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
          )
    )
    return false
  }
}

export function linkKey(connectionId: string, environmentId: string): string {
  return `${connectionId}\0${environmentId}`
}

export function unavailable(message: string): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError('remote_runtime_unavailable', message)
}

/** A phone's refusal reply for a relayed request. */
export function failure(id: string, code: string, message: string): string {
  return JSON.stringify({ id, ok: false, error: { code, message }, _meta: { runtimeId: null } })
}

/** One deadline for everything a link does after its server is prepared (grant sync, then the
 *  socket), so a phone's request is answered within its own deadline. */
export function relaySetupDeadline(budgetMs: number): {
  within: <T>(step: Promise<T>) => Promise<T>
  remaining: () => number
} {
  const deadline = Date.now() + budgetMs
  const remaining = (): number => Math.max(0, deadline - Date.now())
  return {
    remaining,
    within: async (step) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          step,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(unavailable('The server did not answer in time.')),
              remaining()
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
