import './mock-descendant-sweep'
import { rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter input framing', () => {
  it.each([
    { name: '9 MiB of backslashes', text: () => `${'\\'.repeat(9 * 1024 * 1024)}😀` },
    { name: 'sixfold JSON escaping', text: () => '\0'.repeat(3 * 1024 * 1024) },
    {
      name: 'a surrogate at the chunk boundary',
      text: () => `${'\\'.repeat(2 * 1024 * 1024 - 7)}😀 tail`
    },
    { name: 'Enter on the chunk boundary', text: () => '\\'.repeat(2 * 1024 * 1024 - 12) }
  ])('delivers $name through the real daemon with one complete paste frame', async ({ text }) => {
    const subprocess = createMockSubprocess()
    const { adapter, server, dir } = await startDaemonAdapterHarness(() => subprocess)
    try {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const frame = `\x1b[200~${text()}\x1b[201~\r`
      expect(adapter.write(id, frame)).toBe(true)
      await waitFor(() => subprocess.write.mock.calls.some(([data]) => data.endsWith('\r')), 5000)
      expect(subprocess.write.mock.calls.map(([data]) => data).join('')).toBe(frame)
      expect(subprocess.write.mock.calls.at(-1)?.[0].endsWith('\x1b[201~\r')).toBe(true)
    } finally {
      adapter.dispose()
      await server.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
