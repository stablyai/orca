import type { HostStatusReply } from '../transport/hosts/host-status-reply-schema'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import {
  readBridgeConnectionSnapshot,
  type BridgeConnectionSnapshot
} from './bridge/bridge-connection-snapshot'
import { bridgePendingRequestCap } from './bridge/bridge-caps'
import { isPhoneOnlyNativeVerb } from './bridge/bridge-native-verbs'
import type { BridgeClientMessage } from './bridge/bridge-envelope'
import { BridgeCapExceededError, BridgeHostDisposedError } from './bridge-host-errors'

export type DesktopBound = Extract<BridgeClientMessage, { type: 'request' | 'subscribe' }>

// Requests and streams are the frames that can reach the desktop; everything else stays on the phone.
export function isDesktopBound(message: BridgeClientMessage): message is DesktopBound {
  return message.type === 'request' || message.type === 'subscribe'
}

export type BridgeVerdictHold = {
  // A connection whose verdict has not opened is still handshaking to the page.
  snapshot: (client: RpcClient, state?: ConnectionState) => BridgeConnectionSnapshot
  // False when the frame waits for the verdict (or is refused over the cap), or cancels one that waits.
  admit: (message: BridgeClientMessage) => boolean
  // True when a reconnect's re-send of an open page stream waits for the verdict.
  holdReplay: (id: string, resend: () => void) => boolean
  // On the verdict opening: re-send init if what the page last heard changed, then send what waited.
  publish: (resendInit: () => void, dispatch: (message: DesktopBound) => void) => void
  // The document ended; parked frames never left the phone, so a disposal fails them definitely.
  settle: (notify: boolean) => void
  noteInit: () => void
}

// Fail closed: nothing reaches the desktop before this connection's verdict opens the document's window.
// Frames wait rather than fail, as they would in the native client during a reconnect.
export function createBridgeVerdictHold(
  readHostStatus: (() => HostStatusReply | null) | undefined,
  sendError: (id: string, error: unknown) => void
): BridgeVerdictHold {
  // Absent only in harnesses that model no connection verdict.
  const open = (): boolean => readHostStatus === undefined || readHostStatus() !== null
  let openAtInit: boolean | null = null
  let parked: DesktopBound[] = []
  // Keyed by page stream id: a later connection's re-send replaces the one it superseded.
  const replays = new Map<string, () => void>()
  // While anything waits, later frames wait behind it so the verdict's flush keeps page order.
  const passes = (): boolean => open() && parked.length === 0 && replays.size === 0
  const take = (): DesktopBound[] => {
    const taken = parked
    parked = []
    return taken
  }
  return {
    snapshot: (client, state) => {
      const read = readBridgeConnectionSnapshot(client, state)
      return read.state === 'connected' && !open() ? { ...read, state: 'handshaking' } : read
    },
    // status.get is how the page learns the verdict.
    admit: (message) => {
      if (message.type === 'cancel' && parked.some((held) => held.id === message.id)) {
        parked = parked.filter((held) => held.id !== message.id)
        return false
      }
      if (
        !isDesktopBound(message) ||
        passes() ||
        message.method === 'status.get' ||
        isPhoneOnlyNativeVerb(message.method)
      ) {
        return true
      }
      if (parked.length >= bridgePendingRequestCap(false)) {
        sendError(message.id, new BridgeCapExceededError('handshaking'))
      } else {
        parked.push(message)
      }
      return false
    },
    holdReplay: (id, resend) => {
      if (passes()) {
        return false
      }
      replays.set(id, resend)
      return true
    },
    publish: (resendInit, dispatch) => {
      if (openAtInit !== open()) {
        resendInit()
      }
      // Streams the page already held resume before anything it sent while it waited.
      if (open()) {
        const resends = [...replays.values()]
        replays.clear()
        resends.forEach((resend) => resend())
        take().forEach(dispatch)
      }
    },
    settle: (notify) => {
      replays.clear()
      for (const message of take()) {
        if (notify) {
          sendError(message.id, new BridgeHostDisposedError())
        }
      }
    },
    noteInit: () => {
      openAtInit = open()
    }
  }
}
