import { createElement, useMemo } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import {
  useMobileNativeChatRowProps,
  type MobileNativeChatRowLookups,
  type MobileNativeChatRowProps
} from './use-mobile-native-chat-row-props'
import {
  useMobileNativeChatTurnDisclosure,
  type MobileNativeChatTurnRow
} from './use-mobile-native-chat-turn-disclosure'

const NO_NOTICES: ReadonlyMap<string, string> = new Map()
const NO_RUN_OWNERS: ReadonlyMap<string, string> = new Map()
const NO_PREDECESSORS: MobileNativeChatRowLookups['taskListPredecessors'] = new Map()
const rowKeyOf = (message: NativeChatMessage): string => message.id

function useRowProps(
  messages: readonly NativeChatMessage[],
  resolveTurnRow: MobileNativeChatRowLookups['resolveTurnRow'],
  unsentNotices: ReadonlyMap<string, string>
): readonly MobileNativeChatRowProps[] {
  const lookups = useMemo(
    () => ({
      resolveTurnRow,
      rowKeyOf,
      runOwners: NO_RUN_OWNERS,
      taskListPredecessors: NO_PREDECESSORS,
      unsentNotices,
      receipts: null,
      actionablePromptIds: undefined
    }),
    [resolveTurnRow, unsentNotices]
  )
  return useMobileNativeChatRowProps(messages, lookups)
}

const idleTurnRow: MobileNativeChatTurnRow = {
  turnStatus: null,
  turnExpanded: false,
  activeTurnIsWorking: false,
  trailingRun: false,
  userMessageOpen: false,
  onToggleUserMessage: () => {},
  mayStillGrow: false,
  reasoningIsLive: false,
  reasoningExpanded: false,
  onToggleReasoning: () => {},
  onToggleSubagentGroup: () => {}
}

function row(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

let rendered: readonly MobileNativeChatRowProps[] = []

function Harness({
  messages,
  workedSeconds = 4,
  unsentNotices = NO_NOTICES
}: {
  messages: readonly NativeChatMessage[]
  workedSeconds?: number
  unsentNotices?: ReadonlyMap<string, string>
}): null {
  // The host rebuilds this map on every batch, equal values or not.
  const settledTurns: NativeChatSettledTurns = new Map([
    ['u1', { startedAt: 1_000, workedSeconds }]
  ])
  const turns = useMobileNativeChatTurnDisclosure({
    messages,
    enabled: true,
    isWorking: true,
    settledTurns,
    scopeKey: 'host\0worktree\0tab-a'
  })
  rendered = useRowProps(turns.listMessages, turns.resolveRow, unsentNotices)
  return null
}

describe('useMobileNativeChatRowProps', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function rows(): readonly MobileNativeChatRowProps[] {
    return rendered
  }

  function show(
    messages: readonly NativeChatMessage[],
    workedSeconds?: number,
    unsentNotices?: ReadonlyMap<string, string>
  ): void {
    act(() => {
      const element = createElement(Harness, { messages, workedSeconds, unsentNotices })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  const history = [
    row('u1', 'user', 'go'),
    row('a1', 'assistant', 'done'),
    row('u2', 'user', 'next')
  ]

  it('keeps every row, and the array, while only the live reply grows', () => {
    show([...history, row('a2', 'assistant', 'Hel')])
    const before = rows()
    expect(before[0]?.turnStatus).toMatchObject({ workedSeconds: 4 })

    show([...history, row('a2', 'assistant', 'Hello')])

    expect(rows()).toBe(before)
  })

  it('keeps unchanged rows when a new row lands, and rebuilds a row whose values change', () => {
    show([...history, row('a2', 'assistant', 'Hello')])
    const before = rows()

    show([...history, row('a2', 'assistant', 'Hello'), row('u3', 'user', 'more')])
    expect(rows()).not.toBe(before)
    expect(rows()[0]).toBe(before[0])

    show([...history, row('a2', 'assistant', 'Hello'), row('u3', 'user', 'more')], 9)
    expect(rows()[0]).not.toBe(before[0])
    expect(rows()[0]?.turnStatus).toMatchObject({ workedSeconds: 9 })
  })

  it('replaces only the row whose not-sent notice arrives, with turns unchanged', () => {
    const unsent = { ...row('u3', 'user', 'more'), unsent: true as const }
    const messages = [...history, unsent]
    const resolveTurnRow = (): MobileNativeChatTurnRow => idleTurnRow
    function Notices({ notices }: { notices: ReadonlyMap<string, string> }): null {
      rendered = useRowProps(messages, resolveTurnRow, notices)
      return null
    }
    act(() => {
      renderer = create(createElement(Notices, { notices: NO_NOTICES }))
    })
    const before = rows()
    expect(before[3]?.unsentNotice).toBeUndefined()

    act(() =>
      renderer?.update(
        createElement(Notices, { notices: new Map([['u3', 'Not sent: the agent stopped']]) })
      )
    )

    expect(rows()[3]?.unsentNotice).toBe('Not sent: the agent stopped')
    expect(rows()[0]).toBe(before[0])
  })

  it('replaces only the row whose run owner or awaiting state changes', () => {
    const resolveTurnRow = (): MobileNativeChatTurnRow => idleTurnRow
    function Lookups({
      runOwners,
      actionablePromptIds
    }: Pick<MobileNativeChatRowLookups, 'runOwners' | 'actionablePromptIds'>): null {
      const lookups = useMemo(
        () => ({
          resolveTurnRow,
          rowKeyOf,
          runOwners,
          taskListPredecessors: NO_PREDECESSORS,
          unsentNotices: NO_NOTICES,
          receipts: null,
          actionablePromptIds
        }),
        [runOwners, actionablePromptIds]
      )
      rendered = useMobileNativeChatRowProps(history, lookups)
      return null
    }
    act(() => {
      renderer = create(
        createElement(Lookups, { runOwners: NO_RUN_OWNERS, actionablePromptIds: [] })
      )
    })
    const before = rows()

    act(() =>
      renderer?.update(
        createElement(Lookups, {
          runOwners: new Map([['a1', 'u1']]),
          actionablePromptIds: ['u2']
        })
      )
    )

    expect(rows()[0]).toBe(before[0])
    expect(rows()[1]?.runOwner).toBe('u1')
    expect(before[2]?.awaiting).toBe(false)
    expect(rows()[2]?.awaiting).toBe(true)
  })

  it('skips resolving rows on a render that changed neither the rows nor the resolver', () => {
    const resolveTurnRow = vi.fn((): MobileNativeChatTurnRow => idleTurnRow)
    // Stands in for the view re-rendering on a composer keystroke.
    function Static({ composerText }: { composerText: string }): string {
      rendered = useRowProps(history, resolveTurnRow, NO_NOTICES)
      return composerText
    }
    act(() => {
      renderer = create(createElement(Static, { composerText: 'h' }))
    })
    const calls = resolveTurnRow.mock.calls.length
    act(() => renderer?.update(createElement(Static, { composerText: 'hi' })))

    expect(resolveTurnRow.mock.calls.length).toBe(calls)
  })
})
