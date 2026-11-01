import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import type { RelayedStreamCaller } from './relayed-client-stream-admission'
import { RelayedPhoneReplies } from './relayed-phone-frames'

/** A phone, or a paired desktop/web client relayed under runtime.client-relay.v1; the server sees both as phones. */
export type RelayedPhone = RelayedStreamCaller & {
  connectionId: string
  deviceId: string
  deviceToken: string
  clientCapabilities: () => readonly RuntimeCapability[]
  /** Runs once the target names a configured server, before its sync asks for this caller's grant. */
  onServerResolved?: (environmentId: string) => void
  reply: (frame: string) => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
}

export type OpenedRelayLink = { socket: RemoteRuntimePassthroughSocket; hostToken: string }

export class RelayLink {
  readonly replies: RelayedPhoneReplies
  readonly opened: Promise<OpenedRelayLink>
  // The settled link. Requests sent after opening use it synchronously; client binary waits for it.
  ready: OpenedRelayLink | null = null

  constructor(
    readonly environmentId: string,
    readonly phone: RelayedPhone,
    allocateStreamId: () => number,
    open: (link: RelayLink) => Promise<OpenedRelayLink>
  ) {
    this.replies = new RelayedPhoneReplies(allocateStreamId)
    this.opened = open(this)
    this.opened.then(
      (opened) => (this.ready = opened),
      () => {}
    )
  }

  /** Runs `send` now once open, else after opening; queued sends keep their order. */
  whenOpen(send: (opened: OpenedRelayLink) => void): void {
    if (this.ready) {
      send(this.ready)
      return
    }
    this.opened.then(send, () => {})
  }
}
