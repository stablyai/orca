import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createToolInputDisplay } from '../../shared/native-chat-tool-summary'
import {
  codexItemBody,
  codexItemIdentity,
  codexJournalItem,
  codexMessageBlocks,
  CodexTurnOrdinals,
  MAX_CODEX_TURN_ORDINAL_BYTES,
  MAX_CODEX_TURN_ORDINAL_ENTRIES,
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
  it('bounds forgotten turn tombstones while retaining the recent window', () => {
    const ordinals = new CodexTurnOrdinals()
    const total = MAX_CODEX_TURN_ORDINAL_ENTRIES + 12
    for (let index = 0; index < total; index += 1) {
      const turnId = `turn-${index}`
      expect(ordinals.ordinalFor('thread-many', turnId, 'item-0')).toBe(0)
      ordinals.forgetTurn('thread-many', turnId)
    }

    expect(ordinals.forgottenTurnCount).toBe(MAX_CODEX_TURN_ORDINAL_ENTRIES)
    // The newest completed turn still keeps its counter for a late frame.
    expect(ordinals.ordinalFor('thread-many', `turn-${total - 1}`, 'item-late')).toBe(1)
    // The oldest turn was deterministically evicted and starts a fresh key.
    expect(ordinals.ordinalFor('thread-many', 'turn-0', 'item-late')).toBe(0)
  })

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

  it('bounds aggregate provider identifier bytes retained by one active turn', () => {
    const ordinals = new CodexTurnOrdinals()
    for (let index = 0; index < 3_000; index += 1) {
      ordinals.ordinalFor('thread', 'turn', `${index}:${'x'.repeat(512)}`)
    }

    expect(ordinals.bytes).toBeLessThanOrEqual(MAX_CODEX_TURN_ORDINAL_BYTES)
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

  it('names a classified read command by its class and keeps the raw command', () => {
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'item-read',
      command: "sed -n '1,200p' notes.txt",
      cwd: '/repo',
      status: 'completed',
      exitCode: 0,
      commandActions: [
        {
          type: 'read',
          command: "sed -n '1,200p' notes.txt",
          name: 'notes.txt',
          path: '/repo/notes.txt'
        }
      ]
    })

    expect(body).toEqual({
      kind: 'tool-call',
      name: 'read',
      // `name` is the target's basename, which `path` already carries and no
      // label ever reads, so it stays out of the bounded journal payload.
      input: { command: "sed -n '1,200p' notes.txt", cwd: '/repo', path: '/repo/notes.txt' },
      state: 'completed'
    })
    // `read` is the one class that keeps `path`, so its row stays a tappable
    // file on mobile — the other half of the rule `list`/`search` obey below.
    const display = createToolInputDisplay(body?.kind === 'tool-call' ? body.input : null)
    expect(display.filePath).toBe('/repo/notes.txt')
    expect(display.label).toBe('/repo/notes.txt')
  })

  it('carries a classified search query so the row labels by term, not scan root', () => {
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-search',
        command: 'rg -n --no-heading beta .',
        cwd: '/repo',
        status: 'inProgress',
        commandActions: [
          { type: 'search', command: 'rg -n --no-heading beta .', query: 'beta', path: '.' }
        ]
      })
    ).toEqual({
      kind: 'tool-call',
      name: 'search',
      input: { command: 'rg -n --no-heading beta .', cwd: '/repo', query: 'beta', directory: '.' },
      state: 'running'
    })
  })

  it('omits a null classified field rather than standing it in as a target', () => {
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-search-bare',
        command: 'rg beta',
        cwd: '/repo',
        status: 'completed',
        exitCode: 0,
        commandActions: [{ type: 'search', command: 'rg beta', query: null, path: null }]
      })
    ).toEqual({
      kind: 'tool-call',
      name: 'search',
      input: { command: 'rg beta', cwd: '/repo' },
      state: 'completed'
    })
  })

  it('names a classified listFiles command `list` and invents no target for a null path', () => {
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'item-list',
      command: 'ls',
      cwd: '/repo',
      status: 'completed',
      exitCode: 0,
      commandActions: [{ type: 'listFiles', command: 'ls', path: null }]
    })

    expect(body).toEqual({
      kind: 'tool-call',
      name: 'list',
      input: { command: 'ls', cwd: '/repo' },
      state: 'completed'
    })
    // A stand-in `.` reaches mobile as a tappable "open file" link onto a
    // directory, which can only fail. The raw command is the honest label.
    const display = createToolInputDisplay(body?.kind === 'tool-call' ? body.input : null)
    expect(display.filePath).toBeNull()
    expect(display.label).toBe('ls')
  })

  it('keeps the shell row when one command did two different classified things', () => {
    // `cat a.txt && ls src` classifies as a read and a listing; naming the row
    // after either drops the other.
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-mixed',
        command: 'cat a.txt && ls src',
        cwd: '/repo',
        status: 'completed',
        exitCode: 0,
        commandActions: [
          { type: 'read', command: 'cat a.txt', name: 'a.txt', path: 'a.txt' },
          { type: 'listFiles', command: 'ls src', path: 'src' }
        ]
      })
    ).toEqual({
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'cat a.txt && ls src', cwd: '/repo' },
      state: 'completed'
    })
  })

  it('keeps one class run twice, naming no target when the two disagree', () => {
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-two-reads',
        command: 'cat a.ts && cat b.ts',
        cwd: '/repo',
        status: 'completed',
        exitCode: 0,
        commandActions: [
          { type: 'read', command: 'cat a.ts', path: 'a.ts' },
          { type: 'read', command: 'cat b.ts', path: 'b.ts' }
        ]
      })
    ).toEqual({
      kind: 'tool-call',
      name: 'read',
      input: { command: 'cat a.ts && cat b.ts', cwd: '/repo' },
      state: 'completed'
    })
  })

  it('keeps a target both entries of one class name', () => {
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-same-read',
        command: 'head a.ts && tail a.ts',
        cwd: '/repo',
        status: 'completed',
        exitCode: 0,
        commandActions: [
          { type: 'read', command: 'head a.ts', path: 'a.ts' },
          { type: 'read', command: 'tail a.ts', path: 'a.ts' }
        ]
      })
    ).toMatchObject({ name: 'read', input: { path: 'a.ts' } })
  })

  it('keeps the listed directory as a label, never as a file target', () => {
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'item-list-path',
      command: 'ls src',
      cwd: '/repo',
      status: 'completed',
      exitCode: 0,
      commandActions: [{ type: 'listFiles', command: 'ls src', path: 'src' }]
    })

    expect(body).toMatchObject({ name: 'list', input: { directory: 'src' } })
    // Under `path` this reaches mobile as a tappable open-file link onto a
    // directory — the same dead link a stand-in `.` would have produced.
    const display = createToolInputDisplay(body?.kind === 'tool-call' ? body.input : null)
    expect(display.filePath).toBeNull()
    expect(display.label).toBe('src')
  })

  it('keeps a scan root off the file-target key even when the search has no term', () => {
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'item-search-root',
      command: 'rg --files src',
      cwd: '/repo',
      status: 'completed',
      exitCode: 0,
      commandActions: [{ type: 'search', command: 'rg --files src', query: null, path: 'src' }]
    })

    expect(body).toMatchObject({ name: 'search', input: { directory: 'src' } })
    // `path` is only excluded from the file target while a query is present, so
    // a term-less search under it would link to the folder it scanned.
    expect(
      createToolInputDisplay(body?.kind === 'tool-call' ? body.input : null).filePath
    ).toBeNull()
  })

  it('leaves the other classes without a stand-in target', () => {
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-read-null',
        command: 'cat',
        cwd: '/repo',
        status: 'completed',
        exitCode: 0,
        commandActions: [{ type: 'read', command: 'cat', path: null, name: null }]
      })
    ).toEqual({
      kind: 'tool-call',
      name: 'read',
      input: { command: 'cat', cwd: '/repo' },
      state: 'completed'
    })
  })

  it('skips unclassified actions to reach the first classified one', () => {
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-piped',
        command: 'true && cat a.ts',
        cwd: '/repo',
        status: 'completed',
        exitCode: 0,
        commandActions: [
          { type: 'unknown', command: 'true' },
          { type: 'read', command: 'cat a.ts', name: 'a.ts', path: 'a.ts' }
        ]
      })
    ).toMatchObject({ name: 'read', input: { path: 'a.ts' } })
  })

  it('falls back to the unclassified shell row for absent or malformed commandActions', () => {
    const shellRow = {
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'ls', cwd: '/tmp' },
      state: 'completed'
    }
    const base = {
      type: 'commandExecution',
      id: 'item-fallback',
      command: 'ls',
      cwd: '/tmp',
      status: 'completed',
      exitCode: 0
    }

    expect(codexItemBody(base)).toEqual(shellRow)
    expect(codexItemBody({ ...base, commandActions: null })).toEqual(shellRow)
    expect(codexItemBody({ ...base, commandActions: [] })).toEqual(shellRow)
    expect(
      codexItemBody({ ...base, commandActions: [{ type: 'unknown', command: 'ls' }] })
    ).toEqual(shellRow)
    expect(codexItemBody({ ...base, commandActions: 'read' })).toEqual(shellRow)
    expect(codexItemBody({ ...base, commandActions: [null, 7, 'read', {}, { type: 5 }] })).toEqual(
      shellRow
    )
    // The classification table is a Map because an object index answers
    // `__proto__`/`constructor` with a truthy non-string tool name.
    expect(
      codexItemBody({ ...base, commandActions: [{ type: '__proto__', command: 'ls' }] })
    ).toEqual(shellRow)
    expect(
      codexItemBody({ ...base, commandActions: [{ type: 'constructor', command: 'ls' }] })
    ).toEqual(shellRow)
    // The rollout-file shape is a different lane and never reaches app-server.
    expect(
      codexItemBody({ ...base, parsedCmd: [{ type: 'read', cmd: 'ls', path: 'a.ts' }] })
    ).toEqual(shellRow)
  })

  it('accepts snake-case command completion output and preserves blob evidence', () => {
    const output = 'x'.repeat(1_100_000)
    const translated = codexJournalItem({
      type: 'commandExecution',
      id: 'item-large',
      command: 'python big.py',
      status: 'completed',
      exitCode: 0,
      aggregated_output: output
    })
    const body = translated.body

    expect(body).toMatchObject({
      kind: 'tool-call',
      state: 'completed',
      output: {
        byteLength: 1_100_000,
        truncated: true,
        digest: expect.any(String)
      }
    })
    if (body?.kind !== 'tool-call' || !body.output) {
      throw new Error('expected bounded command output')
    }
    expect(body.output.head.length).toBeLessThan(20_000)
  })

  it('continues to accept camel-case command completion output', () => {
    expect(
      codexItemBody({
        type: 'commandExecution',
        id: 'item-camel',
        command: 'printf ok',
        status: 'completed',
        aggregatedOutput: 'ok'
      })
    ).toMatchObject({
      kind: 'tool-call',
      output: { head: 'ok', byteLength: 2, truncated: false }
    })
  })

  it('aggregates assistant content parts before bounding the message body', () => {
    const body = codexItemBody({
      type: 'agentMessage',
      id: 'assistant-parts',
      content: Array.from({ length: 200 }, () => ({ type: 'text', text: 'a'.repeat(10_000) }))
    })
    const text =
      body?.kind === 'message' && body.blocks[0]?.type === 'text' ? body.blocks[0].text : ''

    expect(body).toMatchObject({ kind: 'message', role: 'assistant' })
    expect(body?.kind === 'message' ? body.blocks : []).toHaveLength(1)
    expect(text).toContain('output truncated')
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(20 * 1024)
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
