import { afterEach, expect, it, vi } from 'vitest'
import {
  EmulatorPointerContact,
  type EmulatorPointerContactPacket
} from './emulator-pointer-contact'

afterEach(() => vi.useRealTimers())

it('delivers motion before releasing a drag that ends while motion is deferred', async () => {
  vi.useFakeTimers()
  const packets: EmulatorPointerContactPacket[] = []
  const contact = new EmulatorPointerContact((packet) => {
    packets.push(packet)
    return true
  })
  contact.touch('begin', { x: 0, y: 0 })
  contact.touch('move', { x: 80, y: 160 })
  contact.touch('end', { x: 100, y: 200 })
  await vi.runAllTimersAsync()

  expect(packets).toEqual([
    { x: 0, y: 0, identifier: 0, pressure: 1024 },
    { x: 50, y: 100, identifier: 0, pressure: 1024 },
    { x: 100, y: 200, identifier: 0, pressure: 1024 },
    { x: 100, y: 200, identifier: 0, pressure: 0 }
  ])
})
