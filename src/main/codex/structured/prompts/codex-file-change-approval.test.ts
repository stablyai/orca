import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { createCodexJournalTranslator } from '../journal/codex-structured-journal-translation'
import { codexFileChangeApprovalDetail } from './codex-file-change-approval-detail'
import { CODEX_FILE_CHANGE_APPROVAL_METHOD } from './codex-structured-prompt-replies'
import { chatApprovalFromJournal } from '../../../../shared/native-chat/input/native-chat-interactive-prompt'

// Recorded Codex app-server 0.156.1 frames; only the workspace path is sanitized.
const started = {
  item: {
    type: 'fileChange',
    id: 'exec-114e8eef-018a-444d-8542-aa0232ff1f38',
    changes: [
      {
        path: '/workspace/.codex-probe-write-action.txt',
        kind: { type: 'add' },
        diff: 'codex app-server approval fixture.\n'
      }
    ],
    status: 'inProgress'
  },
  threadId: '01a0d604-629d-7162-b667-18c96f6fdf56',
  turnId: '01a0d604-6358-72f1-bb89-7361cce0045c',
  startedAtMs: 1790297014289
}
const requested = {
  threadId: started.threadId,
  turnId: started.turnId,
  itemId: started.item.id,
  startedAtMs: 1790297014297,
  reason: null,
  grantRoot: null
}

function recorder() {
  const rows: AgentJournalItemBody[] = []
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: (_identity, body) => {
        rows.push(body)
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const announce = (params: typeof started, method = 'item/started') =>
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: params.threadId,
      method,
      params
    })
  const approve = (params: Record<string, unknown> = requested, promptKey = 'request') =>
    translator.handle({
      type: 'prompt',
      sessionId: 'session',
      threadId: started.threadId,
      method: CODEX_FILE_CHANGE_APPROVAL_METHOD,
      params,
      codexItemId: started.item.id,
      promptKey
    })
  return { translator, rows, announce, approve }
}

describe('Codex file-change approval context', () => {
  it('carries recorded announced files into the matching approval and releases completed context', () => {
    const { translator, rows, announce, approve } = recorder()
    announce(started)
    announce({
      ...started,
      threadId: 'another-thread',
      item: {
        ...started.item,
        changes: [{ path: '/private/other.txt', kind: { type: 'add' }, diff: 'other content' }]
      }
    })
    approve()
    expect(rows.find((row) => row.kind === 'approval')).toMatchObject({
      detail:
        'add /workspace/.codex-probe-write-action.txt\n\ncodex app-server approval fixture.\n',
      options: expect.arrayContaining([{ id: 'accept', label: 'Allow' }])
    })
    announce({ ...started, item: { ...started.item, status: 'completed' } }, 'item/completed')
    approve(requested, 'after-completion')
    expect(rows.findLast((row) => row.kind === 'approval')).toMatchObject({ detail: null })
    translator.dispose()
  })

  it('uses the authoritative full announcement after streaming and keeps reason and write scope visible', () => {
    const { translator, rows, announce, approve } = recorder()
    announce({ ...started, item: { ...started.item, changes: [] } })
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: started.threadId,
      method: 'item/fileChange/patchUpdated',
      params: { ...requested, changes: started.item.changes }
    })
    approve(requested, 'without-full-announcement')
    expect(rows.find((row) => row.kind === 'approval')).toMatchObject({ detail: null })
    announce(started)
    approve(
      { ...requested, reason: 'This writes outside the sandbox.', grantRoot: '/workspace' },
      'full-announcement'
    )
    const approval = rows.findLast((row) => row.kind === 'approval')!
    expect(approval).toMatchObject({
      detail: expect.stringContaining('codex app-server approval fixture.\n'),
      decisionReason: 'This writes outside the sandbox.',
      description: 'Write access: /workspace'
    })
    expect(chatApprovalFromJournal(approval)).toMatchObject({
      detail: expect.stringContaining('codex app-server approval fixture.\n'),
      decisionReason: 'This writes outside the sandbox.',
      description: 'Write access: /workspace',
      options: expect.arrayContaining([{ send: 'accept', label: 'Allow' }])
    })
    translator.dispose()
  })

  it('describes every file including empty deletions and displays rename metadata once', () => {
    expect(
      codexFileChangeApprovalDetail([
        { path: '/repo/empty.txt', kind: { type: 'delete' }, diff: '' },
        {
          path: '/repo/old.ts',
          kind: { type: 'update', move_path: '/repo/new.ts' },
          diff: '@@ -1 +1 @@\n-old\n+new\n\nMoved to: /repo/new.ts'
        }
      ])
    ).toBe(
      'delete /repo/empty.txt\nupdate /repo/old.ts -> /repo/new.ts\n\n/repo/old.ts\n@@ -1 +1 @@\n-old\n+new'
    )
  })

  it('lists later files before a large diff and explicitly bounds content without splitting UTF-8', () => {
    const detail = codexFileChangeApprovalDetail([
      { path: '/repo/large.txt', kind: { type: 'add' }, diff: '😀'.repeat(40_000) },
      { path: '/repo/last.txt', kind: { type: 'delete' }, diff: '' }
    ])!
    expect(detail.indexOf('/repo/last.txt')).toBeLessThan(detail.indexOf('😀'))
    expect(detail).toContain('output truncated')
    expect(detail).not.toContain('�')
    expect(Buffer.byteLength(detail)).toBeLessThan(66 * 1024)
  })
})
