import type { HostStatusReply } from '../transport/host-status-reply-schema'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  readBridgeConnectionSnapshot,
  type BridgeConnectionSnapshot
} from './bridge/bridge-connection-snapshot'
import { bridgePendingRequestCap } from './bridge/bridge-caps'
import type { BridgeClientMessage } from './bridge/bridge-envelope'
import { BridgeCapExceededError, BridgeHostDisposedError } from './bridge-host-errors'

export type DesktopBound = Extract<BridgeClientMessage, { type: 'request' | 'subscribe' }>

// Requests and streams are the frames that can reach the desktop; everything else stays on the phone.
export function isDesktopBound(message: BridgeClientMessage): message is DesktopBound {
  return message.type === 'request' || message.type === 'subscribe'
}

// Native verbs that never touch the desktop; any other (native.pdf.view downloads its file) waits like a request.
const PHONE_ONLY_NATIVE_VERBS: ReadonlySet<string> = new Set([
  'native.clipboard.write',
  'native.clipboard.read',
  'native.media.pick',
  'native.media.read',
  'native.media.release',
  'native.media.name',
  'native.audio.start',
  'native.audio.read',
  'native.audio.stop',
  'native.storage.read',
  'native.image.act',
  'native.speech.act'
])

export type BridgeVerdictHold = {
  // A connection whose verdict has not opened is still handshaking to the page.
  snapshot: (client: RpcClient, state?: ConnectionState) => BridgeConnectionSnapshot
  // False when the frame waits for the verdict (or is refused over the cap), or cancels one that waits.
  admit: (message: BridgeClientMessage) => boolean
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
      // While anything waits, later frames wait behind it so the verdict's flush keeps page order.
      if (
        !isDesktopBound(message) ||
        (open() && parked.length === 0) ||
        message.method === 'status.get' ||
        PHONE_ONLY_NATIVE_VERBS.has(message.method)
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
    publish: (resendInit, dispatch) => {
      if (openAtInit !== open()) {
        resendInit()
      }
      if (open()) {
        take().forEach(dispatch)
      }
    },
    settle: (notify) => {
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
