import type { RemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { MobileDesktopRelayHost } from './mobile-desktop-relay-hosts'
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
}
