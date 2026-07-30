import { describe, expect, it } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { HEADER_LENGTH, parseJsonRpcMessage } from './protocol'
import { emitRelayWatcherEvents, emitRelayWatcherOverflow } from './relay-watcher-event-emitter'

function frameMethod(frame: Buffer): string {
  const payloadLength = frame.readUInt32BE(9)
  const message = parseJsonRpcMessage(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLength))
  return 'method' in message ? message.method : ''
}

describe('relay watcher writer admission', () => {
  it('keeps watcher batches on the bounded ordinary lane under saturation', () => {
    const frames: Buffer[] = []
    const drainWaiters: (() => void)[] = []
    let saturate = true
    const dispatcher = new RelayDispatcher(
      (frame) => {
        frames.push(Buffer.from(frame))
        if (saturate) {
          saturate = false
          return false
        }
        return true
      },
      {
        waitWriteDrain: (callback) => {
          drainWaiters.push(callback)
          return () => {
            const index = drainWaiters.indexOf(callback)
            if (index >= 0) {
              drainWaiters.splice(index, 1)
            }
          }
        }
      }
    )

    try {
      emitRelayWatcherEvents(dispatcher, false, [
        { type: 'create', path: '/workspace/first', isDirectory: false }
      ])
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      dispatcher.notifyClient(1, 'control.event')

      expect(frames.map(frameMethod)).toEqual(['fs.changed'])
      drainWaiters.shift()?.()
      expect(frames.map(frameMethod)).toEqual(['fs.changed', 'control.event', 'fs.changed'])
    } finally {
      dispatcher.dispose()
    }
  })
})
