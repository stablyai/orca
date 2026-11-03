import { createTerminalWriteCoalescer } from './terminal-write-coalescer'
import {
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS
} from '../../../src/shared/remote-runtime/remote-runtime-memory-limits'
import type { TerminalApplicationReceipt } from './terminal-webview-contract'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

// Documents share admission across subscription cancellation, reconnect and physical cutover.
let retainedBytes = 0
let retainedFrames = 0
let nextReceipt = 0

type Claim = { bytes: number; applied?: TerminalApplicationReceipt }

export function createTerminalApplicationWriter(post: (command: TerminalWebViewCommand) => void) {
  const claims = new Set<Claim>()
  const receipts = new Map<number, TerminalApplicationReceipt>()
  const admit = (bytes: number, applied?: TerminalApplicationReceipt) => {
    if (
      retainedBytes + bytes > REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES ||
      retainedFrames >= REMOTE_RUNTIME_MAX_PENDING_REQUESTS
    ) {
      throw new Error('Terminal document application buffer overflow')
    }
    const claim = { bytes, applied }
    claims.add(claim)
    retainedBytes += bytes
    retainedFrames++
    return (error?: Error) => {
      if (claims.delete(claim)) {
        retainedBytes -= bytes
        retainedFrames--
        applied?.(error)
      }
    }
  }
  const postApplied = (command: TerminalWebViewCommand, applied: TerminalApplicationReceipt) => {
    const receipt = ++nextReceipt
    receipts.set(receipt, applied)
    post({ ...command, receipt })
  }
  const coalescer = createTerminalWriteCoalescer((data, applied) =>
    postApplied({ type: 'write', data }, applied!)
  )
  return {
    write(data: string, applied?: TerminalApplicationReceipt) {
      coalescer.write(data, admit(data.length * 2, applied))
    },
    flushNow: coalescer.flushNow,
    markInteractive: coalescer.markInteractive,
    clear() {
      coalescer.clear()
      receipts.clear()
      const discarded = Array.from(claims)
      claims.clear()
      retainedBytes -= discarded.reduce((total, claim) => total + claim.bytes, 0)
      retainedFrames -= discarded.length
      for (const claim of discarded) {
        claim.applied?.(new Error('Terminal document discarded'))
      }
    },
    snapshot(command: TerminalWebViewCommand, applied?: TerminalApplicationReceipt) {
      const complete = admit(JSON.stringify(command).length * 2, applied)
      // A replacement holds old claims until the authoritative image actually reaches the parser.
      const superseded = Array.from(receipts.values())
      superseded.push(...coalescer.clear())
      receipts.clear()
      postApplied(command, (error) => {
        superseded.forEach((receipt) => receipt(error))
        complete(error)
      })
    },
    receive(message: Record<string, unknown>) {
      if (message.type !== 'applied' || typeof message.receipt !== 'number') {
        return false
      }
      const applied = receipts.get(message.receipt)
      receipts.delete(message.receipt)
      applied?.()
      return true
    }
  }
}
