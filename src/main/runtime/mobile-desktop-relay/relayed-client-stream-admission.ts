import type { RelayedPhoneReplies } from './relayed-phone-frames'
import type { RelayedStreamCarrier } from './relayed-stream-carriers'

export type RelayedStreamCaller = {
  /** Only a runtime client that negotiated it may relay client-stream-ids methods; phones never do. */
  carriesClientStreams?: boolean
  /** Whether this connection already drives local binary streams, whose input a relayed lane would take. */
  hasLocalBinaryStreams?: () => boolean
}

type Refusal = { code: 'forbidden'; message: string }

/** Client binary frames name no server, so a connection's whole binary lane belongs to one relayed multiplex:
 * refuse it beside local or other relayed binary streams, and refuse those beside it. */
export function relayedStreamRefusal(
  method: string,
  carrier: RelayedStreamCarrier | undefined,
  caller: RelayedStreamCaller,
  connectionLinks: readonly RelayedPhoneReplies[]
): Refusal | null {
  const laneOwned = connectionLinks.some((replies) => replies.carriesClientStreams())
  if ((carrier === 'terminal-stream-id' || carrier === 'untagged-binary') && laneOwned) {
    return refused('A relayed terminal multiplex already carries this connection’s binary frames')
  }
  if (carrier !== 'client-stream-ids') {
    return null
  }
  if (caller.carriesClientStreams !== true) {
    return refused(
      `Method '${method}' is driven by binary frames, which the desktop does not relay`
    )
  }
  if (laneOwned) {
    return refused('This connection already relays a terminal multiplex')
  }
  if (
    caller.hasLocalBinaryStreams?.() === true ||
    connectionLinks.some((replies) => replies.carriesOtherBinaryStreams())
  ) {
    return refused(
      'Open a relayed terminal multiplex on a connection that carries no other streams'
    )
  }
  return null
}

function refused(message: string): Refusal {
  return { code: 'forbidden', message }
}
