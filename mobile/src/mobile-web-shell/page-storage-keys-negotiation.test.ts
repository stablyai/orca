import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { harness } from './bridge-host-test-harness'
import { clientFrame } from './bridge-host-test-fakes'

const SPLIT_KEY = 'orca:terminalSplitLayout'
const STORAGE = { [SPLIT_KEY]: 'stacked', 'orca:pins:host-a': '["wt-1"]' }

function lastInit(posted: readonly string[]): Record<string, unknown> {
  const init = posted
    .map((json): unknown => JSON.parse(json))
    .findLast(
      (frame): frame is Record<string, unknown> =>
        z.object({ type: z.literal('init') }).safeParse(frame).success
    )
  if (init === undefined) {
    throw new Error('no init was posted')
  }
  return init
}

describe('negotiated page storage keys across page and shell versions', () => {
  it('pushes a storage change only to a page whose ready named the key', () => {
    const key = 'orca:markdownTextScale'
    const older = harness({ storage: STORAGE })
    older.host.receive(clientFrame({ type: 'ready' }))
    older.host.publishStorageUpdate(key, '1.5')
    expect(older.frames().some((frame) => frame.type === 'storage')).toBe(false)

    const current = harness({ storage: STORAGE })
    current.host.receive(JSON.stringify(createPageReadyFrame()))
    current.host.publishStorageUpdate(key, '1.5')
    expect(current.frames().filter((frame) => frame.type === 'storage')).toEqual([
      expect.objectContaining({ key, value: '1.5' })
    ])
  })

  it('reads a malformed storageKeys list as none rather than refusing the ready', () => {
    const bridge = harness({ storage: STORAGE })
    bridge.host.receive(clientFrame({ type: 'ready', storageKeys: [SPLIT_KEY, 7] }))

    expect(bridge.pageReadyCount()).toBe(1)
    expect(lastInit(bridge.posted).storage).toEqual({ 'orca:pins:host-a': '["wt-1"]' })
  })
})
