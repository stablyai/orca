import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function coreFor(emulator: unknown): Record<string, unknown> {
  if (
    !record(emulator) ||
    !(emulator.terminal instanceof Terminal) ||
    !('_core' in emulator.terminal) ||
    !record(emulator.terminal._core)
  ) {
    throw new Error('Installed headless terminal shape changed')
  }
  return emulator.terminal._core
}

describe.each(['synchronous', 'asynchronous'] as const)('headless %s OSC link cleanup', (mode) => {
  it('retires overwritten links through the production write path', async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    const core = coreFor(emulator)
    if (mode === 'asynchronous') {
      Object.defineProperty(core, 'writeSync', { value: undefined })
    }
    const service = core._oscLinkService
    if (!record(service) || !(service._dataByLinkId instanceof Map)) {
      throw new Error('Installed headless link registry changed')
    }
    try {
      const redraw = '\r\x1b]8;;https://example.test/live\x1b\\x\x1b]8;;\x1b\\'
      for (let batch = 0; batch < 16; batch++) {
        await emulator.write(redraw.repeat(256))
      }
      expect(service._dataByLinkId.size).toBeLessThanOrEqual(1024)
      expect(emulator.getSnapshot().oscLinks).toEqual([
        { row: 0, startCol: 0, endCol: 1, uri: 'https://example.test/live' }
      ])
    } finally {
      emulator.dispose()
    }
  })
})
