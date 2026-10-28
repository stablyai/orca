import { describe, expect, it, vi } from 'vitest'
import type { AXNode } from './snapshot-ax-tree-walk'
import { buildSnapshot, type CdpCommandSender } from './snapshot-engine'

function buttonTree(count: number, name = 'Submit'): AXNode[] {
  const buttons = Array.from({ length: count }, (_, i) => ({
    nodeId: String(i + 2),
    backendDOMNodeId: i + 10,
    role: { type: 'role', value: 'button' },
    name: { type: 'computedString', value: name }
  }))
  return [
    {
      nodeId: '1',
      role: { type: 'role', value: 'WebArea' },
      childIds: buttons.map((n) => n.nodeId)
    },
    ...buttons
  ]
}

function sender(nodes: AXNode[], cursor = false): CdpCommandSender {
  return vi.fn(async (method, params) => {
    if (method === 'Accessibility.enable') {
      return {}
    }
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes }
    }
    if (method === 'DOM.describeNode') {
      return { node: { backendNodeId: 100 } }
    }
    if (method === 'Runtime.evaluate') {
      if (params?.expression === 'window.__orcaCursorInteractive[0]') {
        return { result: { objectId: 'cursor-object' } }
      }
      return { result: { value: JSON.stringify(cursor ? [{ text: 'Cursor', tag: 'div' }] : []) } }
    }
    throw new Error(`Unexpected CDP method: ${method}`)
  })
}

describe('buildSnapshot iframe sessions', () => {
  it('preserves ref order, within-frame duplicate names and session ownership', async () => {
    const parent = sender(buttonTree(1, 'Parent'), true)
    const frameA = sender(buttonTree(2, 'Frame A'))
    const frameB = sender(buttonTree(1, 'Frame B'))
    const empty = sender([])
    const stale = vi.fn(async () => {
      throw new Error('Session closed')
    })
    const senders = new Map<string, CdpCommandSender>([
      ['session-a', frameA],
      ['session-empty', empty],
      ['session-stale', stale],
      ['session-b', frameB]
    ])
    const makeIframeSender = vi.fn((sessionId: string) => senders.get(sessionId)!)
    const sessions = new Map([
      ['frame-a', 'session-a'],
      ['frame-empty', 'session-empty'],
      ['frame-stale', 'session-stale'],
      ['frame-b', 'session-b']
    ])

    const result = await buildSnapshot(parent, sessions, makeIframeSender)

    expect(result.snapshot).toBe(
      [
        '[@e1] button "Parent"',
        '[@e2] clickable "Cursor"',
        '  [@e3] button "Frame A"',
        '  [@e4] button "Frame A (2nd)"',
        '  [@e5] button "Frame B"'
      ].join('\n')
    )
    expect(result.refs).toEqual([
      { ref: '@e1', role: 'button', name: 'Parent' },
      { ref: '@e2', role: 'clickable', name: 'Cursor' },
      { ref: '@e3', role: 'button', name: 'Frame A' },
      { ref: '@e4', role: 'button', name: 'Frame A (2nd)' },
      { ref: '@e5', role: 'button', name: 'Frame B' }
    ])
    expect([...result.refMap]).toEqual([
      [
        '@e1',
        {
          backendDOMNodeId: 10,
          role: 'button',
          name: 'Parent',
          sessionId: undefined,
          nth: undefined
        }
      ],
      [
        '@e2',
        {
          backendDOMNodeId: 100,
          role: 'clickable',
          name: 'Cursor',
          sessionId: undefined,
          nth: undefined
        }
      ],
      [
        '@e3',
        { backendDOMNodeId: 10, role: 'button', name: 'Frame A', sessionId: 'session-a', nth: 1 }
      ],
      [
        '@e4',
        { backendDOMNodeId: 11, role: 'button', name: 'Frame A', sessionId: 'session-a', nth: 2 }
      ],
      [
        '@e5',
        {
          backendDOMNodeId: 10,
          role: 'button',
          name: 'Frame B',
          sessionId: 'session-b',
          nth: undefined
        }
      ]
    ])
    expect(makeIframeSender.mock.calls.flat()).toEqual([...sessions.values()])
    for (const frame of [frameA, empty, frameB]) {
      expect(vi.mocked(frame).mock.calls.map(([method]) => method)).toEqual([
        'Accessibility.enable',
        'Accessibility.getFullAXTree'
      ])
    }
    expect(stale).toHaveBeenCalledExactlyOnceWith('Accessibility.enable')
  })

  it('does not reuse session mappings across snapshots', async () => {
    const sessions = new Map([['frame', 'session-a']])
    const withFrame = await buildSnapshot(sender(buttonTree(1)), sessions, () =>
      sender(buttonTree(1))
    )
    const withoutFrame = await buildSnapshot(sender(buttonTree(2)))
    expect(withFrame.refMap.get('@e2')?.sessionId).toBe('session-a')
    expect(withoutFrame.refMap.get('@e2')?.sessionId).toBeUndefined()
  })

  it.each([0, 100, 1000])(
    'uses one indexed lookup per emitted ref with %i iframe refs',
    async (iframeCount) => {
      const parentCount = 100
      const sessions = new Map([
        ['frame-a', 'session-a'],
        ['frame-b', 'session-b']
      ])
      let lookups = 0
      const originalGet = Map.prototype.get
      const getSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown
      ) {
        if (typeof key === 'string' && key.startsWith('@e')) {
          lookups++
        }
        return originalGet.call(this, key)
      })
      let result: Awaited<ReturnType<typeof buildSnapshot>>
      try {
        result = await buildSnapshot(sender(buttonTree(parentCount)), sessions, () =>
          sender(buttonTree(iframeCount / 2))
        )
      } finally {
        getSpy.mockRestore()
      }

      expect(result.refs).toHaveLength(parentCount + iframeCount)
      expect(lookups).toBe(parentCount + iframeCount)
      const legacySessions = Array.from({ length: iframeCount }, (_, i) => ({
        ref: `@e${parentCount + i + 1}`,
        sessionId: i < iframeCount / 2 ? 'session-a' : 'session-b'
      }))
      let legacyComparisons = 0
      for (const [ref, entry] of result.refMap) {
        const legacySession = legacySessions.find((candidate) => {
          legacyComparisons++
          return candidate.ref === ref
        })
        expect(entry.sessionId).toBe(legacySession?.sessionId)
      }
      expect(legacyComparisons).toBe(
        parentCount * iframeCount + (iframeCount * (iframeCount + 1)) / 2
      )
    }
  )
})
