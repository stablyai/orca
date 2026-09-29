import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

function userMessage(id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  }
}

function Harness({
  messages,
  enabled,
  isWorking = true,
  settledTurns,
  workingStartedAt,
  activeTurnOpenedBy,
  turnKeysByItemId,
  scopeKey = 'host\0worktree\0tab-a'
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking?: boolean
  settledTurns?: NativeChatSettledTurns
  workingStartedAt?: number | null
  activeTurnOpenedBy?: string | null
  turnKeysByItemId?: ReadonlyMap<string, string> | null
  scopeKey?: string
}): React.JSX.Element {
  const disclosure = useMobileNativeChatTurnDisclosure({
    messages,
    enabled,
    isWorking,
    settledTurns,
    workingStartedAt,
    activeTurnOpenedBy,
    turnKeysByItemId,
    scopeKey
  })
  return createElement('result', { disclosure })
}

describe('useMobileNativeChatTurnDisclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not scan bridge-lane transcripts', () => {
    const messages: NativeChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    const findLastIndex = vi.spyOn(messages, 'findLastIndex')
    const slice = vi.spyOn(messages, 'slice')
    const filter = vi.spyOn(messages, 'filter')
    const map = vi.spyOn(messages, 'map')

    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: false }))
    })

    expect(findLastIndex).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
    expect(map).not.toHaveBeenCalled()
  })

  it('keeps a settled turn handler stable for NUL-delimited scope keys', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages: NativeChatMessage[] = [
        {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'go' }],
          timestamp: null,
          source: 'transcript'
        }
      ]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      vi.setSystemTime(6_000)
      act(() => {
        renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
      })
      const first = renderer!.root.findByType('result').props.disclosure.resolveRow(0, messages[0])

      const refreshed = [...messages]
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: refreshed, enabled: true, isWorking: false })
        )
      })
      const second = renderer!.root
        .findByType('result')
        .props.disclosure.resolveRow(0, refreshed[0])

      // The row carries the key; the handler itself lives on the hook and stays
      // stable for the scope, so a re-render never disturbs a row's memo.
      expect(first.turnKey).toBe('u1')
      expect(second.turnKey).toBe('u1')
      const firstHandler = renderer!.root.findByType('result').props.disclosure.onToggleTurn
      expect(firstHandler).toBeTypeOf('function')
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: [...refreshed], enabled: true, isWorking: false })
        )
      })
      expect(renderer!.root.findByType('result').props.disclosure.onToggleTurn).toBe(firstHandler)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the host-recorded duration over the locally observed one', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1')]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      // Locally this turn ran 5s; the host says 3m 17s and the host wins.
      vi.setSystemTime(6_000)
      const settledTurns = new Map([['u1', { startedAt: 500, workedSeconds: 197 }]])
      act(() => {
        renderer?.update(
          createElement(Harness, { messages, enabled: true, isWorking: false, settledTurns })
        )
      })
      const row = renderer!.root.findByType('result').props.disclosure.resolveRow(0, messages[0])
      expect(row.turnStatus).toEqual({ startedAt: 500, thinking: false, workedSeconds: 197 })
      expect(row.turnKey).toBe('u1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the live bar on every render until it settles in place', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1')]
      const seen: unknown[] = []
      function Recorder({ isWorking }: { isWorking: boolean }): React.JSX.Element {
        const disclosure = useMobileNativeChatTurnDisclosure({
          messages,
          enabled: true,
          isWorking,
          scopeKey: 'host\0worktree\0tab-a'
        })
        seen.push(disclosure.resolveRow(0, messages[0]).turnStatus)
        return createElement('result', { disclosure })
      }
      act(() => {
        renderer = create(createElement(Recorder, { isWorking: true }))
      })
      vi.setSystemTime(6_000)
      seen.length = 0
      // No host duration for this turn: the settle is stamped locally, one pass later.
      act(() => {
        renderer?.update(createElement(Recorder, { isWorking: false }))
      })
      expect(seen).not.toContain(null)
      expect(seen.at(-1)).toEqual({ startedAt: 1_000, thinking: false, workedSeconds: 5 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses local duration when the host explicitly cannot verify the end', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1')]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      vi.setSystemTime(60_000)
      act(() => {
        renderer?.update(
          createElement(Harness, {
            messages,
            enabled: true,
            isWorking: false,
            settledTurns: new Map([['u1', null]])
          })
        )
      })
      const row = renderer!.root.findByType('result').props.disclosure.resolveRow(0, messages[0])
      expect(row.turnStatus).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the live bar under the prompt that opened the running turn, not a mid-turn send', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const tool: NativeChatMessage = {
        id: 'tool-a',
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'Bash', input: { command: 'sleep 15' }, state: 'running' }
        ],
        timestamp: null,
        source: 'transcript'
      }
      const messages = [userMessage('A'), tool, userMessage('B')]
      const rows = () => {
        const disclosure = renderer!.root.findByType('result').props.disclosure
        return messages.map((message, index) => disclosure.resolveRow(index, message))
      }
      // B was sent while A's turn runs; the host still names A as the running turn's opener.
      act(() => {
        renderer = create(
          createElement(Harness, {
            messages,
            enabled: true,
            workingStartedAt: 5_000,
            activeTurnOpenedBy: 'A'
          })
        )
      })
      let [rowA, rowTool, rowB] = rows()
      expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: null })
      expect(rowB.turnStatus).toBeNull()
      // Liveness follows the owning turn: A's tool row stays live while B waits.
      expect(rowTool.activeTurnIsWorking).toBe(true)
      expect(rowB.activeTurnIsWorking).toBe(false)

      // B's own turn opens: A takes the host's settled duration, B counts from A's end.
      act(() => {
        renderer?.update(
          createElement(Harness, {
            messages,
            enabled: true,
            workingStartedAt: 22_000,
            settledTurns: new Map([['A', { startedAt: 5_000, workedSeconds: 17 }]]),
            activeTurnOpenedBy: 'B'
          })
        )
      })
      ;[rowA, , rowB] = rows()
      expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: 17 })
      expect(rowB.turnStatus).toEqual({ startedAt: 22_000, thinking: false, workedSeconds: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a running turn's rows live across a mid-turn send the host folded in", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const tool = (id: string): NativeChatMessage => ({
        id,
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'Bash', input: { command: 'sleep 15' }, state: 'running' }
        ],
        timestamp: null,
        source: 'transcript'
      })
      // The #23621 shape: B lands mid-turn and the tool rows after it are still A's.
      const messages = [userMessage('A'), tool('t1'), userMessage('B'), tool('t2')]
      const owned = new Map([
        ['A', 'A'],
        ['t1', 'A'],
        ['B', 'A'],
        ['t2', 'A']
      ])
      act(() => {
        renderer = create(
          createElement(Harness, {
            messages,
            enabled: true,
            workingStartedAt: 5_000,
            activeTurnOpenedBy: 'A',
            turnKeysByItemId: owned
          })
        )
      })
      const disclosure = renderer!.root.findByType('result').props.disclosure
      const [rowA, rowT1, rowB, rowT2] = messages.map((message, index) =>
        disclosure.resolveRow(index, message)
      )
      expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: null })
      // The steered bubble shares A's turn but never carries a bar of its own.
      expect(rowB.turnStatus).toBeNull()
      expect(rowT1.activeTurnIsWorking).toBe(true)
      expect(rowT2.activeTurnIsWorking).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("anchors a provider-opened turn's bar above its first row", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const woke: NativeChatMessage = {
        id: 'woke',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Woke up.' }],
        timestamp: null,
        source: 'transcript'
      }
      const messages = [userMessage('u1'), woke]
      act(() => {
        renderer = create(
          createElement(Harness, {
            messages,
            enabled: true,
            isWorking: false,
            settledTurns: new Map([['wake', { startedAt: 5_000, workedSeconds: 9 }]]),
            turnKeysByItemId: new Map([
              ['u1', 'u1'],
              ['woke', 'wake']
            ])
          })
        )
      })
      const disclosure = renderer!.root.findByType('result').props.disclosure
      const [rowU1, rowWoke] = messages.map((message, index) =>
        disclosure.resolveRow(index, message)
      )
      expect(rowU1.turnStatus).toBeNull()
      expect(rowWoke.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: 9 })
      expect(rowWoke.turnStatusAbove).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never hands a provider-opened turn's clock to a message sent during it", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const row = (id: string): NativeChatMessage => ({
        id,
        role: 'assistant',
        blocks: [{ type: 'text', text: id }],
        timestamp: null,
        source: 'transcript'
      })
      // A wake turn runs; B is sent during it and folded in, so B opened nothing.
      const messages = [row('w1'), userMessage('B'), row('w2')]
      const owned = new Map([
        ['w1', 'wake'],
        ['B', 'wake'],
        ['w2', 'wake']
      ])
      act(() => {
        renderer = create(
          createElement(Harness, {
            messages,
            enabled: true,
            workingStartedAt: 5_000,
            activeTurnOpenedBy: 'wake',
            turnKeysByItemId: owned,
            settledTurns: new Map([['wake', null]])
          })
        )
      })
      // The wake turn settles: the host no longer names a running turn.
      vi.setSystemTime(20_000)
      act(() => {
        renderer!.update(
          createElement(Harness, {
            messages,
            enabled: true,
            isWorking: false,
            workingStartedAt: null,
            activeTurnOpenedBy: null,
            turnKeysByItemId: owned,
            settledTurns: new Map([['wake', { startedAt: 5_000, workedSeconds: 15 }]])
          })
        )
      })
      const disclosure = renderer!.root.findByType('result').props.disclosure
      const [rowW1, rowB] = messages.map((message, index) => disclosure.resolveRow(index, message))
      expect(rowW1.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: 15 })
      expect(rowB.turnStatus).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most the latest 128 turns expanded', () => {
    vi.useFakeTimers()
    try {
      let messages: NativeChatMessage[] = []
      for (let index = 0; index < 129; index++) {
        messages = messages.concat(userMessage(`u${index}`))
        vi.setSystemTime(index * 2_000)
        act(() => {
          if (renderer) {
            renderer.update(createElement(Harness, { messages, enabled: true }))
          } else {
            renderer = create(createElement(Harness, { messages, enabled: true }))
          }
        })
        vi.setSystemTime(index * 2_000 + 1_000)
        act(() => {
          renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
        })
        const disclosureNow = renderer!.root.findByType('result').props.disclosure
        const row = disclosureNow.resolveRow(index, messages[index])
        act(() => disclosureNow.onToggleTurn(row.turnKey))
      }

      const disclosure = renderer!.root.findByType('result').props.disclosure
      const expanded = messages.filter(
        (message, index) => disclosure.resolveRow(index, message).turnExpanded
      )
      expect(expanded).toHaveLength(128)
      expect(disclosure.resolveRow(0, messages[0]).turnExpanded).toBe(false)
      expect(disclosure.resolveRow(128, messages[128]).turnExpanded).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
