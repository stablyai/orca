import { describe, expect, it } from 'vitest'
import { codexJournalItem } from './codex-structured-item-translation'
import { codexRolloutItem } from '../../history/rollouts/codex-rollout-item-projection'
import { projectCodexHistoryItem } from '../../history/journal-views/codex-history-projection'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { itemBlocks } from '../../../../shared/agent-session/view/structured-agent-session-item-blocks'
import { agentJournalItemForWire } from '../../../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import {
  buildEditCards,
  buildEditSummaries
} from '../../../../shared/native-chat/tools/native-chat-edit-cards'

// Clients parse the wire form, whose diff is cut to a bounded head.
function wireBlocks(body: AgentJournalItemBody | null) {
  if (!body) {
    throw new Error('no journal body')
  }
  const item = { itemId: 'fc1', revision: 1, body, sequence: 1, observedAt: 0 }
  return itemBlocks(agentJournalItemForWire(item).item)?.blocks ?? []
}

function turnEdits(body: AgentJournalItemBody | null) {
  const blocks = wireBlocks(body)
  return {
    summary: [...buildEditSummaries(blocks).values()].flatMap((entry) =>
      entry.files.map(({ path, oldPath, changeKind, added, removed }) => ({
        path,
        oldPath,
        changeKind,
        added,
        removed
      }))
    ),
    cardRows: [...buildEditCards(blocks).editCards.values()].flatMap((entry) =>
      entry.files.map((file) =>
        file.lines.map(
          (line) => `${line.kind}:${line.text}:${line.oldLineNumber ?? line.newLineNumber}`
        )
      )
    )
  }
}

function fileChangeEdits(changes: unknown[]) {
  return turnEdits(
    codexJournalItem({ type: 'fileChange', id: 'fc1', status: 'completed', changes }).body
  )
}

describe('Codex multi-file fileChange', () => {
  it('names every file of one apply_patch, whatever each change did', () => {
    expect(
      fileChangeEdits([
        {
          path: 'C:\\w\\a.txt',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-Original A\n+Updated A\n'
        },
        { path: '/w/new.txt', kind: { type: 'add' }, diff: 'one\r\ntwo\r\n' },
        { path: '/w/old.txt', kind: { type: 'delete' }, diff: 'gone' },
        {
          path: '/w/from.txt',
          kind: { type: 'update', move_path: '/w/to.txt' },
          diff: '@@ -2 +2 @@\n-x\n+y\n\n\nMoved to: /w/to.txt'
        }
      ])
    ).toEqual({
      summary: [
        { path: 'C:\\w\\a.txt', oldPath: null, changeKind: 'edited', added: 1, removed: 1 },
        { path: '/w/new.txt', oldPath: null, changeKind: 'added', added: 2, removed: 0 },
        { path: '/w/old.txt', oldPath: null, changeKind: 'deleted', added: 0, removed: 1 },
        { path: '/w/to.txt', oldPath: '/w/from.txt', changeKind: 'renamed', added: 1, removed: 1 }
      ],
      cardRows: [
        ['del:Original A:1', 'add:Updated A:1'],
        ['add:one:1', 'add:two:2'],
        ['del:gone:1'],
        ['del:x:2', 'add:y:2']
      ]
    })
  })

  it('keeps the rename destination of a change restored from rollout history', () => {
    const item = codexRolloutItem({
      type: 'file_change',
      id: 'fc1',
      status: 'completed',
      changes: {
        '/w/from.txt': {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-x\n+y\n',
          move_path: '/w/to.txt'
        },
        '/w/b.txt': { type: 'update', unified_diff: '@@ -1 +1 @@\n-B\n+C\n' }
      }
    })
    expect(turnEdits(item && codexJournalItem(item).body).summary).toEqual([
      { path: '/w/b.txt', oldPath: null, changeKind: 'edited', added: 1, removed: 1 },
      { path: '/w/to.txt', oldPath: '/w/from.txt', changeKind: 'renamed', added: 1, removed: 1 }
    ])
  })

  it('names no file from diff text inside content that older hosts joined without headers', () => {
    const added =
      'Example:\ndiff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n'
    expect(
      turnEdits({
        kind: 'diff',
        path: '2 files',
        paths: ['/w/doc.md', '/w/b.txt'],
        patch: {
          head: `${added}\n@@ -1 +1 @@\n-C\n+D\n`,
          byteLength: 0,
          digest: '',
          truncated: false
        }
      })
    ).toEqual({ summary: [], cardRows: [] })
  })

  it('names no file from a git patch that older hosts saved as content with as many files', () => {
    const added = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/y.ts b/y.ts',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -1 +1 @@',
      '-c',
      '+d',
      ''
    ].join('\n')
    expect(
      turnEdits({
        kind: 'diff',
        path: '2 files',
        paths: ['/w/fix.patch', '/w/b.txt'],
        patch: {
          head: `${added}\n@@ -1 +1 @@\n-C\n+D\n`,
          byteLength: 0,
          digest: '',
          truncated: false
        }
      })
    ).toEqual({ summary: [], cardRows: [] })
  })

  it.each(['/w/a\tb.txt', '/w/a\nb.txt', ' /w/a.txt', '/w/a.txt '])(
    'keeps the plain join for a name headers cannot carry: %j',
    (path) => {
      const changes = [
        { path, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-A\n+B\n' },
        {
          path: '/w/b.txt',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-C\n+D\n'
        }
      ]
      const body = codexJournalItem({
        type: 'fileChange',
        id: 'fc1',
        status: 'completed',
        changes
      }).body
      expect(body).toMatchObject({
        patch: { head: '@@ -1 +1 @@\n-A\n+B\n\n@@ -1 +1 @@\n-C\n+D\n' }
      })
      expect(turnEdits(body)).toEqual({ summary: [], cardRows: [] })
    }
  )

  it('keeps every file named when history restores a saved patch without its changes', () => {
    const saved = codexJournalItem({
      type: 'fileChange',
      id: 'fc1',
      status: 'completed',
      changes: [
        {
          path: '/w/a.txt',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-A\n+B\n'
        },
        {
          path: '/w/b.txt',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-C\n+D\n'
        }
      ]
    }).body
    if (!saved) {
      throw new Error('no saved body')
    }
    const restored = projectCodexHistoryItem(
      { type: 'fileChange', id: 'fc1', status: 'completed' },
      { itemId: 'fc1', revision: 1, body: saved, sequence: 1, observedAt: 0 }
    )
    expect(turnEdits(restored).summary.map((file) => file.path)).toEqual(['/w/a.txt', '/w/b.txt'])
  })

  it('keeps the raw row and its full output when the wire head cuts a multi-file patch', () => {
    const changes = [
      // Under the wire head raw, past it once every line is signed.
      { path: '/w/a.txt', kind: { type: 'add' }, diff: 'x\n'.repeat(8000) },
      { path: '/w/b.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-B\n+C\n' }
    ]
    const body = codexJournalItem({
      type: 'fileChange',
      id: 'fc1',
      status: 'completed',
      changes
    }).body
    expect(turnEdits(body)).toEqual({ summary: [], cardRows: [] })
    expect(wireBlocks(body).find((block) => block.type === 'tool-result')).toMatchObject({
      fullOutputItemId: 'fc1'
    })
  })
})
