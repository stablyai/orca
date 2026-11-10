import { expect, it } from 'vitest'
import { sendScrcpyDisplayScroll } from './scrcpy-control-input'

it('sends rotated display scroll positions in scrcpy’s aligned coordinate space', () => {
  const packets: Buffer[] = []
  sendScrcpyDisplayScroll(
    {
      videoSize: () => null,
      sendControl: (packet) => {
        packets.push(packet)
        return true
      }
    },
    { width: 1080, height: 2220 },
    1,
    [1, 1, 0, -1]
  )

  expect(packets.map((packet) => packet.toString('hex'))).toEqual([
    '03000008a70000043708a804380000800000000000'
  ])
})
