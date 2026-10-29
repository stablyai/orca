import { expect, it } from 'vitest'
import { deferred } from './orca-runtime-test-fixtures.spec'
import { createHydrationRuntime, PTY_ID, SIZE } from './headless-hydration-ownership-test-fixture'

it('does not replay live bytes the renderer seed already painted', async () => {
  const runtime = createHydrationRuntime()
  const rendered = deferred<{ data: string; cols: number; rows: number; seq: number }>()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => SIZE,
    hasRendererSerializer: () => true,
    serializeBuffer: () => rendered.promise
  })

  // The renderer parses these while main awaits its serialization.
  runtime.onPtyData(PTY_ID, 'LIVE-ONE\r\n', 1)
  runtime.onPtyData(PTY_ID, '\x1b[38;5', 2)
  runtime.onPtyData(PTY_ID, ';242mLIVE-TWO\x1b[0m\r\n', 3)
  rendered.resolve({ data: 'HISTORY\r\nLIVE-ONE\r\n', ...SIZE, seq: 16 })
  await runtime.model().writeChain

  const screen = runtime.model().emulator.getVisibleLines().join('\n')
  expect(screen.match(/LIVE-ONE/g)).toHaveLength(1)
  expect(screen).toContain('LIVE-TWO')
  expect(screen).not.toContain(';242m')
})
