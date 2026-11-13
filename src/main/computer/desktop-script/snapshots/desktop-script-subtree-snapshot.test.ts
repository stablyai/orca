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

  it('gives a different element at the same runtime id a new index', async () => {
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 frame Mail', '\t1 list Inbox', '\t\t2 button Archive'],
        [
          { index: 0, runtimeId: [0] },
          { index: 1, runtimeId: [0, 0] },
          { index: 2, runtimeId: [0, 0, 0], name: 'Archive' }
        ]
      )
    })
    await client.snapshot({ app: 'Mail' })

    // Linux runtime ids are tree positions, so a replacement can arrive at the same id.
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 list Inbox', '\t1 button Delete'],
        [
          { index: 0, runtimeId: [0, 0] },
          { index: 1, runtimeId: [0, 0, 0], name: 'Delete' }
        ]
      )
    })
    const read = await client.snapshot({ app: 'Mail', rootElementIndex: 1 })

    expect(read.snapshot.treeText.split('\n').slice(4, 6)).toEqual([
      '1 list Inbox',
      '\t3 button Delete'
    ])
  })

  it('keeps the requested root’s index when its name changed', async () => {
    const client = await createDesktopScriptProviderClient('windows', 'runtime.ps1')
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 window Inbox - Mail', '\t1 list Inbox'],
        [
          { index: 0, runtimeId: [42, 7], name: 'Inbox - Mail' },
          { index: 1, runtimeId: [42, 8] }
        ]
      )
    })
    await client.snapshot({ app: 'Mail' })

    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 window Sent - Mail', '\t1 list Sent'],
        [
          { index: 0, runtimeId: [42, 7], name: 'Sent - Mail' },
          { index: 1, runtimeId: [42, 8] }
        ]
      )
    })
    const read = await client.snapshot({ app: 'Mail', rootElementIndex: 0 })

    expect(read.snapshot.treeText.split('\n').slice(4, 6)).toEqual([
      '0 window Sent - Mail',
      '\t1 list Sent'
    ])
  })

  it('keeps an elided root resolvable while forgetting the children it replaced', async () => {
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(
        ['0 frame Mail', '\t1 panel Pane', '\t\t2 button A'],
        [
          { index: 0, runtimeId: [0] },
          { index: 1, runtimeId: [0, 0] },
          { index: 2, runtimeId: [1, 0] }
        ]
      )
    })
    await client.snapshot({ app: 'Mail' })

    // The provider elides the empty pane, so each read starts at its recreated child: index 3, then 4.
    let sentRoot: unknown
    for (const generation of [1, 2]) {
      mockBridgeResponse(
        {
          ok: true,
          snapshot: bridgeSnapshot(['0 button A'], [{ index: 0, runtimeId: [1, generation] }])
        },
        (operation) => {
          sentRoot = operation.root
        }
      )
      await client.snapshot({ app: 'Mail', rootElementIndex: 1 })
    }

    expect(sentRoot).toMatchObject({ runtimeId: [0, 0] })
    mockBridgeResponse({ ok: true, capabilities: sampleCapabilities() })
    mockBridgeResponse({
      ok: true,
      snapshot: bridgeSnapshot(['0 frame Mail'], [{ index: 0, runtimeId: [0] }])
    })
    await expect(client.action('click', { app: 'Mail', elementIndex: 3 })).rejects.toMatchObject({
      code: 'element_not_found'
    })
  })
})
