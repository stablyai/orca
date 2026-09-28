import './mock-descendant-sweep'
import { rmSync } from 'node:fs'
import { expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

it.each([1024 * 1024, 3 * 1024 * 1024])(
  'delivers %i startup characters through the public server and adapter',
  async (length) => {
    let confirm!: () => void
    const receipt = new Promise<void>((resolve) => {
      confirm = resolve
    })
    let subscribed = false
    const subprocess = createMockSubprocess()
    const harness = await startDaemonAdapterHarness(async (opts) => {
      opts.onSpawnAttempt?.(
        () => subprocess,
        async () => {
          subprocess.forceKill()
        }
      )
      subscribed = true
      await receipt
      return subprocess
    })
    const observed: string[] = []
    harness.adapter.onData((event) => {
      observed.push(event.data)
    })
    const viewer = new HeadlessEmulator({ cols: 80, rows: 24 })
    try {
      const pending = harness.adapter.spawn({ cols: 80, rows: 24, sessionId: 'startup-stream' })
      await waitFor(() => subscribed)
      const startup = `\x1b[?2004h${'x'.repeat(length)}\r\nSTARTUP_END`
      for (let offset = 0; offset < startup.length; offset += 16 * 1024) {
        subprocess._simulateData(startup.slice(offset, offset + 16 * 1024))
      }
      expect(observed).toEqual([])
      confirm()
      const result = await pending
      expect(result.isReattach).toBeUndefined()
      expect(result.providerSequence).toEqual({ value: 0, generation: 'reset' })
      await waitFor(() => observed.join('').includes('STARTUP_END'))
      subprocess._simulateData('\r\nLIVE_END')
      await waitFor(() => observed.join('').includes('LIVE_END'))
      for (const data of observed) {
        await viewer.write(data)
      }
      expect(viewer.getSnapshot().modes.bracketedPaste).toBe(true)
      expect(viewer.getSnapshot().snapshotAnsi).toContain('LIVE_END')
      expect(observed.join('').match(/STARTUP_END/g)).toHaveLength(1)
      if (length < 2 * 1024 * 1024) {
        expect(observed.join('')).toBe(`${startup}\r\nLIVE_END`)
      }
    } finally {
      viewer.dispose()
      harness.adapter.dispose()
      await harness.server.shutdown()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  }
)
