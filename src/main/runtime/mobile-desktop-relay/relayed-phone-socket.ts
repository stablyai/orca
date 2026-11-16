import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { openRemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { relayedPhoneCapabilities } from './relayed-phone-frames'
import { unavailable, type RelayLink, type OpenedRelayLink } from './mobile-desktop-relay-link'
import type { MobileDesktopRelayHost } from './mobile-desktop-relay-hosts'

export async function openRelayedPhoneSocket(
  link: RelayLink,
  host: MobileDesktopRelayHost,
  grant: { token: string; deviceId: string },
  grants: { refused: Set<string> },
  isCurrent: () => boolean,
  endLink: (error: RemoteRuntimeClientError | null) => void
): Promise<OpenedRelayLink> {
  try {
    const socket = await openRemoteRuntimePassthroughSocket(
      {
        ...pairedRuntimeConnectionFromOffer(host.pairing),
        credential: { kind: 'token', deviceToken: grant.token },
        pairedDeviceId: grant.deviceId
      },
      relayedPhoneCapabilities(link.phone.clientCapabilities()),
      {
        onText: (plaintext) => {
          const frame = link.replies.text(plaintext)
          if (frame !== null) {
            link.phone.reply(frame)
          }
        },
        onBinary: (bytes) => {
          const frame = link.replies.binary(bytes)
          if (frame) {
            link.phone.sendBinary(frame)
          }
        },
        onClose: (error) => endLink(error)
      },
      { timeoutMs: link.setup.remaining() }
    )
    if (!isCurrent()) {
      socket.close()
      throw unavailable('The relayed request was cancelled.')
    }
    return { socket, hostToken: grant.token, host }
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError && error.code === 'unauthorized') {
      // Retrying revoked tokens would repeatedly raise the host unpaired-device prompt.
      grants.refused.add(link.phone.deviceId)
      throw unavailable('The server revoked this link.phone.')
    }
    throw error
  }
}
