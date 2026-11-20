import WebSocket from 'ws'
import {
  encodeServeSimTouchFrame,
  type ServeSimTouchFrame
} from '../../shared/emulator/emulator-touch-frame'

export type EmulatorGesturePoint = ServeSimTouchFrame

export function sendEmulatorGestureSequence(
  wsUrl: string,
  points: EmulatorGesturePoint[]
): Promise<void> {
  return sendServeSimFrameSequence(wsUrl, points.map(encodeServeSimTouchFrame))
}

/** Sends encoded helper frames 16 ms apart over one socket, then closes it. */
export async function sendServeSimFrameSequence(
  wsUrl: string,
  frames: readonly Uint8Array[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let index = 0
    let timer: NodeJS.Timeout | null = null
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    const sendNext = (): void => {
      if (index >= frames.length) {
        cleanup()
        timer = setTimeout(() => {
          resolve()
          ws.close()
        }, 50)
        return
      }
      ws.send(Buffer.from(frames[index++]))
      timer = setTimeout(sendNext, 16)
    }
    ws.on('open', sendNext)
    ws.on('error', (error) => {
      cleanup()
      reject(error)
    })
    ws.on('close', () => {
      cleanup()
      reject(new Error('Emulator input stream closed before sequence completion'))
    })
  })
}
