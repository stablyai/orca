import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from '../desktop-script-provider-test-harness'

function bridgeSnapshot(treeLines: string[], elements: { index: number; runtimeId: number[] }[]) {
  return { ...sampleBridgeSnapshot('Mail', ''), windowIndex: 0, treeLines, elements }
}

describe('DesktopScriptProviderClient subtree reads', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('keeps shown indexes, numbers hidden children after them, and resolves them for actions', async () => {
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 frame Mail', '\t1 list Inbox', '\t\t2 button A', '\t\t... 1 more not shown'],
        [
          { index: 0, runtimeId: [0] },
          { index: 1, runtimeId: [0, 0] },
          { index: 2, runtimeId: [0, 0, 0] }
        ]
      )
    })
    await client.snapshot({ app: 'Mail' })

    let sentRoot: unknown
    mockBridgeResponse(
      {
        ok: true,
        snapshot: bridgeSnapshot(
          ['0 list Inbox', '\t1 button A', '\t2 button B'],
          [
            { index: 0, runtimeId: [0, 0] },
            { index: 1, runtimeId: [0, 0, 0] },
            { index: 2, runtimeId: [0, 0, 1] }
          ]
        )
      },
      (operation) => {
        sentRoot = operation.root
      }
    )
    const subtree = await client.snapshot({ app: 'Mail', rootElementIndex: 1 })

    expect(sentRoot).toMatchObject({ index: 1, runtimeId: [0, 0] })
    expect(subtree.snapshot.rootElementIndex).toBe(1)
    expect(subtree.snapshot.treeText.split('\n').slice(2, 7)).toEqual([
      'Showing element 1 and its descendants.',
      '',
      '1 list Inbox',
      '\t2 button A',
      '\t3 button B'
    ])

    let clicked: unknown
    mockBridgeResponse({ ok: true, capabilities: sampleCapabilities() })
    mockBridgeResponse(
      { ok: true, snapshot: bridgeSnapshot(['0 frame Mail'], [{ index: 0, runtimeId: [0] }]) },
      (operation) => {
        clicked = operation.element
      }
    )
    await client.action('click', { app: 'Mail', elementIndex: 3 })
    expect(clicked).toMatchObject({ runtimeId: [0, 0, 1] })
  })
})
