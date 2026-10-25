import { expect, it, vi } from 'vitest'
import { createHydrationRuntime, PTY_ID, SIZE } from './headless-hydration-ownership-test-fixture'

const LINES = Array.from({ length: 1500 }, (_, i) => `L${String(i + 1).padStart(4, '0')} line`)

it('hydrates main from the renderer at desktop depth so a hidden-output reveal keeps history', async () => {
  const runtime = createHydrationRuntime()
  const serialize = vi.fn(async (_ptyId: string, opts?: { scrollbackRows?: number }) => ({
    data: LINES.slice(-((opts?.scrollbackRows ?? 0) + SIZE.rows)).join('\r\n'),
    ...SIZE
  }))
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => SIZE,
    hasRendererSerializer: () => true,
    serializeBuffer: serialize
  })

  runtime.onPtyData(PTY_ID, '\r\n$ ', 1)
  await runtime.model().writeChain

  expect(serialize).toHaveBeenCalledWith(PTY_ID, { scrollbackRows: 5000 })
  const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID, {
    scrollbackRows: 5000
  })
  const restored = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
  expect(restored.match(/L\d{4} line/g)).toHaveLength(1500)
  expect(restored).toContain('L0001 line')
})
