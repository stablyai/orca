import WebSocket from 'ws'
import {
  encodeServeSimTouchFrame,
  type ServeSimTouchFrame
} from '../../shared/emulator-touch-frame'

export type EmulatorGesturePoint = ServeSimTouchFrame

export async function sendEmulatorGestureSequence(
  wsUrl: string,
  points: EmulatorGesturePoint[]
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
      if (index >= points.length) {
        cleanup()
        timer = setTimeout(() => {
          resolve()
          ws.close()
        }, 50)
        return
      }
      const point = points[index++]
      ws.send(Buffer.from(encodeServeSimTouchFrame(point)))
      timer = setTimeout(sendNext, 16)
    }
    ws.on('open', sendNext)
    ws.on('error', (error) => {
      cleanup()
      reject(error)
    })
    ws.on('close', () => {
      cleanup()
      reject(new Error('Emulator gesture stream closed before sequence completion'))
    })
  })
}
