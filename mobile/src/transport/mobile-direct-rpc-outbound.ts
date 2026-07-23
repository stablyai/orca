import { createWsOutboundBackpressureQueue } from '../../../src/shared/ws-outbound-backpressure-queue'
import { getUtf8ByteLength } from '../../../src/shared/utf8-byte-limits'
import { encrypt } from './e2ee'
import {
  processMobileOutboundMemoryBudget,
  MOBILE_OUTBOUND_MAX_FRAME_BYTES,
  type MobileOutboundMemoryBudget
} from './mobile-outbound-memory-budget'
import { createMobileOutboundSocketLedger } from './mobile-outbound-socket-ledger'

type DirectRpcOutboundFrame = {
  acknowledgementKey?: string
  key: Uint8Array
  plaintext: string
}

type DirectRpcOutboundSocket = {
  OPEN: number
  bufferedAmount: number
  readyState: number
  send(frame: string): void
}

export type MobileDirectRpcOutbound = {
  acknowledge(key: string): void
  acknowledgeAuthentication(): void
  dispose(): void
  enqueue(plaintext: string, key: Uint8Array, acknowledgementKey?: string): boolean
  socketClosed(): void
}

const AUTHENTICATION_ACKNOWLEDGEMENT_KEY = 'mobile-direct-authentication'

export function createMobileDirectRpcOutbound(args: {
  socket: DirectRpcOutboundSocket
  isActive: () => boolean
  onOverflow: () => void
  memoryBudget?: MobileOutboundMemoryBudget
}): MobileDirectRpcOutbound {
  const memoryBudget = args.memoryBudget ?? processMobileOutboundMemoryBudget
  let stopped = false
  let disposed = false
  let overflowed = false
  const socketLedger = createMobileOutboundSocketLedger({
    memoryBudget,
    readBufferedAmount: () => args.socket.bufferedAmount
  })
  const failOverflow = (): void => {
    if (overflowed) {
      return
    }
    overflowed = true
    stopped = true
    args.onOverflow()
  }
  const queue = createWsOutboundBackpressureQueue<DirectRpcOutboundFrame>({
    send: (frame) => {
      const bytes = encryptedTextFrameBytes(frame.plaintext)
      const cancelClaim = socketLedger.claimSentBytes(bytes, frame.acknowledgementKey)
      if (!cancelClaim) {
        failOverflow()
        return
      }
      try {
        args.socket.send(encrypt(frame.plaintext, frame.key))
      } catch {
        cancelClaim()
        failOverflow()
      }
    },
    byteLengthOf: (frame) => encryptedTextFrameBytes(frame.plaintext),
    getBufferedAmount: () => args.socket.bufferedAmount,
    isWritable: () => args.isActive() && args.socket.readyState === args.socket.OPEN && !stopped,
    canSend: (bytes) => socketLedger.canSend(bytes),
    claimQueuedBytes: (bytes) => memoryBudget.claimQueuedBytes(bytes),
    maxFrameBytes: MOBILE_OUTBOUND_MAX_FRAME_BYTES,
    onOverflow: failOverflow
  })

  return {
    acknowledge: (key) => socketLedger.acknowledge(key),
    acknowledgeAuthentication: () => socketLedger.acknowledge(AUTHENTICATION_ACKNOWLEDGEMENT_KEY),
    dispose(): void {
      if (disposed) {
        return
      }
      disposed = true
      stopped = true
      queue.dispose()
      socketLedger.retire()
    },
    enqueue(plaintext, key, acknowledgementKey): boolean {
      if (stopped || !args.isActive() || args.socket.readyState !== args.socket.OPEN) {
        return false
      }
      const accepted = queue.enqueue({
        plaintext,
        key,
        acknowledgementKey:
          acknowledgementKey ??
          (isAuthenticationRequest(plaintext) ? AUTHENTICATION_ACKNOWLEDGEMENT_KEY : undefined)
      })
      return accepted && !overflowed
    },
    socketClosed(): void {
      stopped = true
      queue.dispose()
      socketLedger.socketClosed()
    }
  }
}

function encryptedTextFrameBytes(plaintext: string): number {
  const encryptedBytes = getUtf8ByteLength(plaintext) + 40
  const wireBytes = Math.ceil(encryptedBytes / 3) * 4
  return Math.max(wireBytes, plaintext.length * 2)
}

function isAuthenticationRequest(plaintext: string): boolean {
  try {
    const value = JSON.parse(plaintext) as { type?: unknown }
    return value.type === 'e2ee_auth'
  } catch {
    return false
  }
}
