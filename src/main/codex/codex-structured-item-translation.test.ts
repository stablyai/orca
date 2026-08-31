import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  codexItemBody,
  codexItemIdentity,
  codexMessageBlocks,
  CodexTurnOrdinals,
  isCodexMessageItemType,
  readCodexThreadItem,
  type CodexThreadItem
} from './codex-structured-item-translation'

const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

/**
 * Captured from a live `codex app-server` turn: Codex numbers items in arrival
 * order and includes the command it ran.
 */
const LIVE_TURN: CodexThreadItem[] = [
  { type: 'userMessage', id: 'item-0', content: [{ type: 'text', text: 'list the files' }] },
  { type: 'agentMessage', id: 'item-1', text: 'Let me look.' },
  {
    type: 'commandExecution',
    id: 'item-2',
    command: 'ls',
    cwd: '/tmp',
    status: 'completed',
    exitCode: 0,
    aggregatedOutput: 'a\nb\n'
  },
  { type: 'agentMessage', id: 'item-3', text: 'Two files.' }
]

/**
 * The SAME turn read back after `thread/resume`: ids are renumbered from 1 and
 * the command execution is gone entirely, because Codex does not persist it.
 */
const RESUMED_TURN: CodexThreadItem[] = [
  { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'list the files' }] },
  { type: 'agentMessage', id: 'item-2', text: 'Let me look.' },
  { type: 'agentMessage', id: 'item-3', text: 'Two files.' }
]

function keysFor(items: CodexThreadItem[]): string[] {
  const ordinals = new CodexTurnOrdinals()
  return items
    .filter((item) => isCodexMessageItemType(item.type))
    .map((item) =>
      agentJournalItemKey(
        codexItemIdentity({ threadId: THREAD_ID, turnId: TURN_ID, item, ordinals })
      )
    )
}

describe('codex turn ordinals', () => {
  it('releases a forgotten turn without ever reusing an ordinal it assigned', () => {
    const ordinals = new CodexTurnOrdinals()
    expect(ordinals.ordinalFor('thread-1', 'turn-1', 'item-1')).toBe(0)
    expect(ordinals.ordinalFor('thread-1', 'turn-1', 'item-2')).toBe(1)

    ordinals.forgetTurn('thread-1', 'turn-1')

    // A straggler for the released turn — even a previously seen item id — gets
    // a FRESH ordinal: reusing a released slot would upsert another item's row.
    expect(ordinals.ordinalFor('thread-1', 'turn-1', 'item-1')).toBe(2)
    expect(ordinals.ordinalFor('thread-1', 'turn-1', 'item-3')).toBe(3)
    // Other turns are untouched.
    expect(ordinals.ordinalFor('thread-1', 'turn-2', 'item-1')).toBe(0)
  })
})

describe('codex item identity', () => {
  it('gives a resumed turn the same message keys as the live turn it renumbered', () => {
    expect(keysFor(LIVE_TURN)).toEqual(keysFor(RESUMED_TURN))
  })

  it('numbers messages 0,1,2 on both sides — the projection skips the dropped command', () => {
    const ordinals = new CodexTurnOrdinals()
    const live = LIVE_TURN.map((item) =>
      codexItemIdentity({ threadId: THREAD_ID, turnId: TURN_ID, item, ordinals })
    )

    expect(live.map((id) => (id.provider === 'codex' ? id.ordinal : null))).toEqual([0, 1, null, 2])
  })

  it('survives an item type this build does not model without consuming a message ordinal', () => {
    const withUnknown = [
      LIVE_TURN[0] as CodexThreadItem,
      { type: 'somethingCodexAddedLater', id: 'item-9' },
      LIVE_TURN[1] as CodexThreadItem
    ]

    expect(keysFor(withUnknown)).toEqual(keysFor([LIVE_TURN[0], LIVE_TURN[1]] as CodexThreadItem[]))
  })

  it('assigns an ordinal once and reuses it, so a delta and its completion upsert one row', () => {
    const ordinals = new CodexTurnOrdinals()
    ordinals.ordinalFor(THREAD_ID, TURN_ID, 'item-0')

    expect(ordinals.ordinalFor(THREAD_ID, TURN_ID, 'item-1')).toBe(1)
    expect(ordinals.ordinalFor(THREAD_ID, TURN_ID, 'item-0')).toBe(0)
  })

  it('restarts numbering per turn', () => {
    const ordinals = new CodexTurnOrdinals()
    ordinals.ordinalFor(THREAD_ID, TURN_ID, 'item-0')

    expect(ordinals.ordinalFor(THREAD_ID, 'turn-2', 'item-1')).toBe(0)
  })

  it('keys a non-message item and a turnless message in the orca namespace', () => {
    const ordinals = new CodexTurnOrdinals()
    const command = codexItemIdentity({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: LIVE_TURN[2] as CodexThreadItem,
      ordinals
    })
    const orphan = codexItemIdentity({
      threadId: THREAD_ID,
      turnId: null,
      item: LIVE_TURN[1] as CodexThreadItem,
      ordinals
    })

    expect(command).toEqual({ provider: 'orca', clientMessageId: 'codex-item:thread-abc:item-2' })
    expect(orphan).toEqual({ provider: 'orca', clientMessageId: 'codex-item:thread-abc:item-1' })
  })
})

describe('codex item bodies', () => {
  it('reads structured user content and flat agent text alike', () => {
    expect(codexMessageBlocks(LIVE_TURN[0] as CodexThreadItem)).toEqual([
      { type: 'text', text: 'list the files' }
    ])
    expect(codexMessageBlocks(LIVE_TURN[1] as CodexThreadItem)).toEqual([
      { type: 'text', text: 'Let me look.' }
    ])
  })

  it('keeps provider image echoes in mixed user content', () => {
    expect(
      codexMessageBlocks({
        type: 'userMessage',
        id: 'm',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', url: 'https://example.test/a.png' },
          { type: 'localImage', path: '/tmp/a.png' }
        ]
      })
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image-ref', url: 'https://example.test/a.png' },
      { type: 'image-ref', path: '/tmp/a.png' }
    ])
  })

  it('maps a finished zero-exit command to a completed shell tool call', () => {
    expect(codexItemBody(LIVE_TURN[2] as CodexThreadItem)).toEqual({
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'ls', cwd: '/tmp' },
      state: 'completed',
      output: { head: 'a\nb\n', byteLength: 4, truncated: false, digest: expect.any(String) }
    })
  })

  it('calls a nonzero exit a failure even though codex calls the status completed', () => {
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'item-2',
      command: 'false',
      status: 'completed',
      exitCode: 1
    })

    expect(body).toMatchObject({ state: 'failed' })
  })

  it('treats an unfinished command as running and an aborted one as failed', () => {
    expect(
      codexItemBody({ type: 'commandExecution', id: 'a', command: 'sleep', status: 'inProgress' })
    ).toMatchObject({ state: 'running' })
    expect(
      codexItemBody({ type: 'commandExecution', id: 'a', command: 'sleep', status: 'aborted' })
    ).toMatchObject({ state: 'failed' })
  })

  it('maps file changes to one bounded diff item', () => {
    expect(
      codexItemBody({
        type: 'fileChange',
        id: 'patch-1',
        status: 'completed',
        changes: [
          { path: 'src/a.ts', diff: '@@ a @@' },
          { path: 'src/b.ts', diff: '@@ b @@' }
        ]
      })
    ).toMatchObject({
      kind: 'diff',
      path: '2 files',
      patch: { head: '@@ a @@\n@@ b @@', truncated: false }
    })
  })

  it('renders reasoning as status and exposes an unknown item as a provider frame', () => {
    expect(codexItemBody({ type: 'reasoning', id: 'r', text: 'thinking' })).toEqual({
      kind: 'status',
      text: 'thinking'
    })
    expect(codexItemBody({ type: 'reasoning', id: 'r' })).toBeNull()
    expect(codexItemBody({ type: 'agentMessage', id: 'm', text: '' })).toBeNull()
    expect(codexItemBody({ type: 'webSearch', id: 'w' })).toMatchObject({
      kind: 'status',
      text: 'codex · item:webSearch',
      providerFrame: { provider: 'codex', kind: 'item:webSearch' }
    })
  })

  it('renders array-shaped reasoning content', () => {
    expect(
      codexItemBody({
        type: 'reasoning',
        id: 'r',
        summary: ['first', 'second'],
        content: [{ text: 'fallback' }]
      })
    ).toEqual({ kind: 'status', text: 'first\nsecond' })
  })

  it('refuses a value that is not a thread item at all', () => {
    expect(readCodexThreadItem({ type: 'agentMessage' })).toBeNull()
    expect(readCodexThreadItem(null)).toBeNull()
    expect(readCodexThreadItem({ type: 'agentMessage', id: 'm' })).not.toBeNull()
  })
})
