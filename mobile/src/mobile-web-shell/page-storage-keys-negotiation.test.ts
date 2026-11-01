import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { harness } from './bridge-host-test-harness'
import { clientFrame } from './bridge-host-test-fakes'
import { createPageReadyFrame } from './bridge/bridge-client-init-handshake'

const SPLIT_KEY = 'orca:terminalSplitLayout'
const STORAGE = { [SPLIT_KEY]: 'stacked', 'orca:pins:host-a': '[\"wt-1\"]' }

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
  it('keeps a dismissed-subagent record out of an older page init', () => {
    const key = 'orca:dismissedSubagents:host-a:wt-1'
    const bridge = harness({ storage: { ...STORAGE, [key]: '{}' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))

    expect(lastInit(bridge.posted).storage).toEqual({ 'orca:pins:host-a': '[\"wt-1\"]' })
  })

  it('hands a dismissed-subagent record to a page whose ready names the prefix', () => {
    const key = 'orca:dismissedSubagents:host-a:wt-1'
    const storage = { ...STORAGE, [key]: '{}' }
    const bridge = harness({ storage })
    bridge.host.receive(JSON.stringify(createPageReadyFrame()))

    expect(lastInit(bridge.posted).storage).toEqual(storage)
  })

  it('reads a malformed storageKeys list as none rather than refusing the ready', () => {
    const bridge = harness({ storage: STORAGE })
    bridge.host.receive(clientFrame({ type: 'ready', storageKeys: [SPLIT_KEY, 7] }))

    expect(bridge.pageReadyCount()).toBe(1)
    expect(lastInit(bridge.posted).storage).toEqual({ 'orca:pins:host-a': '[\"wt-1\"]' })
  })
})
