import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from '../desktop-script-provider-test-harness'

function bridgeSnapshot(
  treeLines: string[],
  elements: { index: number; runtimeId: number[]; name?: string }[]
) {
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

describe('DesktopScriptProviderClient repeated subtree reads', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('forgets children a live list replaced and keeps indexes outside the list', async () => {
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 frame Mail', '\t1 list Inbox', '\t2 button Send'],
        [
          { index: 0, runtimeId: [0] },
          { index: 1, runtimeId: [0, 0] },
          { index: 2, runtimeId: [0, 1] }
        ]
      )
    })
    await client.snapshot({ app: 'Mail' })

    // The list recreates its child with a fresh runtime id on every read; each gets a never-used index.
    let shownChild = ''
    for (const generation of [1, 2]) {
      mockBridgeResponse({
        ok: true,
        snapshot: bridgeSnapshot(
          ['0 list Inbox', '\t1 button A'],
          [
            { index: 0, runtimeId: [0, 0] },
            { index: 1, runtimeId: [1, generation] }
          ]
        )
      })
      const read = await client.snapshot({ app: 'Mail', rootElementIndex: 1 })
      shownChild = read.snapshot.treeText.split('\n')[5]
    }
    expect(shownChild).toBe('\t4 button A')

    let sentRoot: unknown
    mockBridgeResponse(
      {
        ok: true,
        snapshot: bridgeSnapshot(['0 button Send'], [{ index: 0, runtimeId: [0, 1] }])
      },
      (operation) => {
        sentRoot = operation.root
      }
    )
    await client.snapshot({ app: 'Mail', rootElementIndex: 2 })
    expect(sentRoot).toMatchObject({ runtimeId: [0, 1] })

    // Answer the click in case the replaced child's index still resolves, so the assertion fails cleanly.
    mockBridgeResponse({ ok: true, capabilities: sampleCapabilities() })
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(['0 frame Mail'], [{ index: 0, runtimeId: [0] }])
    })
    await expect(client.action('click', { app: 'Mail', elementIndex: 3 })).rejects.toMatchObject({
      code: 'element_not_found'
    })
  })

  it('renumbers a different element at a known runtime id but keeps the requested root', async () => {
    const client = await createDesktopScriptProviderClient('windows', 'runtime.ps1')
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 window Inbox - Mail', '\t1 button Archive'],
        [
          { index: 0, runtimeId: [42, 7], name: 'Inbox - Mail' },
          { index: 1, runtimeId: [42, 8], name: 'Archive' }
        ]
      )
    })
    await client.snapshot({ app: 'Mail' })

    // Both renamed; only the root is known to be the same element, since the read started from it.
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 window Sent - Mail', '\t1 button Delete'],
        [
          { index: 0, runtimeId: [42, 7], name: 'Sent - Mail' },
          { index: 1, runtimeId: [42, 8], name: 'Delete' }
        ]
      )
    })
    const read = await client.snapshot({ app: 'Mail', rootElementIndex: 0 })

    expect(read.snapshot.treeText.split('\n').slice(4, 6)).toEqual([
      '0 window Sent - Mail',
      '\t2 button Delete'
    ])
  })

  it('keeps an elided root readable under cache pressure and forgets its replaced children', async () => {
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    const outside = Array.from({ length: 1198 }, (_, index) => ({
      index: index + 2,
      runtimeId: [10, index]
    }))
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 frame Mail', '\t1 panel Pane', ...outside.map(({ index }) => `\t${index} list Other`)],
        [{ index: 0, runtimeId: [0] }, { index: 1, runtimeId: [1] }, ...outside]
      )
    })
    await client.snapshot({ app: 'Mail' })

    const expanded = Array.from({ length: 1199 }, (_, index) => ({
      index: index + 1,
      runtimeId: [20, index]
    }))
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 list Other', ...expanded.map(({ index }) => `\t${index} button Other`)],
        [{ index: 0, runtimeId: [10, 0] }, ...expanded]
      )
    })
    await client.snapshot({ app: 'Mail', rootElementIndex: 2 })

    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 list Items', '\t1 button A', '\t2 button B'],
        [
          { index: 0, runtimeId: [30, 0] },
          { index: 1, runtimeId: [30, 1] },
          { index: 2, runtimeId: [30, 2] }
        ]
      )
    })
    await client.snapshot({ app: 'Mail', rootElementIndex: 1 })

    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(['0 panel Pane'], [{ index: 0, runtimeId: [1] }])
    })
    const repeated = await client.snapshot({ app: 'Mail', rootElementIndex: 1 })
    expect(repeated.snapshot.treeText.split('\n')[4]).toBe('1 panel Pane')

    mockBridgeResponse({ ok: true, capabilities: sampleCapabilities() })
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(['0 frame Mail'], [{ index: 0, runtimeId: [0] }])
    })
    await expect(client.action('click', { app: 'Mail', elementIndex: 2399 })).rejects.toMatchObject(
      {
        code: 'element_not_found'
      }
    )
  })
})
