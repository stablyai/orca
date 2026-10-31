import { afterEach, expect, it } from 'vitest'
import { editFilesFromToolPair } from '../../shared/native-chat/tools/native-chat-edit-normalize'
import { decodeOmpTranscriptLine } from '../native-chat/transcript-line-decoders-omp'
import { ompResolvedEdits } from './rpc-edit-results'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

const changedFile = {
  path: 'README.md',
  diff: '-1 old\n+1 new',
  op: 'update',
  oldText: 'old\n',
  newText: 'new\n'
}

it('renders provider-resolved edits through the same existing diff display for live and historical results', async () => {
  const h = await setupOmpRpcAdapter()
  h.connection.receive({ type: 'agent_start' })
  const result = { content: [{ type: 'text', text: 'Applied' }], details: changedFile }
  h.connection.receive({
    type: 'tool_execution_end',
    toolCallId: 'edit-1',
    toolName: 'edit',
    result
  })
  const rows = await h.rig.rows()
  const diff = rows.find((row) => row.body.kind === 'diff')?.body
  if (diff?.kind !== 'diff') {
    throw new Error('Resolved diff not journaled')
  }
  expect(diff.path).toBe('README.md')
  expect(diff.patch.head).toContain('-old\n+new')
  const replay = decodeOmpTranscriptLine(
    JSON.stringify({
      type: 'message',
      id: 'result',
      message: { role: 'toolResult', toolName: 'edit', ...result }
    }),
    'result'
  )
  expect(replay?.blocks[0]).toEqual({ type: 'tool-result', output: 'Applied' })
  const call = replay?.blocks.find((block) => block.type === 'tool-call')
  const output = replay?.blocks.at(-1)
  if (call?.type !== 'tool-call' || output?.type !== 'tool-result') {
    throw new Error('Historical diff not retained')
  }
  const files = editFilesFromToolPair({
    name: call.name,
    input: call.input,
    state: call.state,
    result: output
  })
  expect(files?.[0]).toMatchObject({ path: 'README.md', lineNumbersKnown: true })
  expect(
    files?.[0]?.lines.filter((line) => line.kind === 'del' || line.kind === 'add')
  ).toMatchObject([
    { kind: 'del', text: 'old' },
    { kind: 'add', text: 'new' }
  ])
})

it('keeps failed or pruned edits generic and never treats other tools as an applied edit', () => {
  expect(ompResolvedEdits({ diff: '', errorKind: 'hash-mismatch' }, 'edit')).toEqual([])
  expect(
    ompResolvedEdits({ path: 'README.md', diff: '-2 old\n+2 new', snapshotsPruned: true }, 'edit')
  ).toEqual([])
  expect(ompResolvedEdits(changedFile, 'bash')).toEqual([])
  expect(
    ompResolvedEdits({ perFileResults: [changedFile, { path: 'failed', diff: '' }] }, 'edit')
  ).toHaveLength(1)
})

it.each([
  {
    op: 'create',
    oldText: undefined,
    newText: 'new\n',
    sourcePath: undefined,
    changeKind: 'added'
  },
  {
    op: 'delete',
    oldText: 'old\n',
    newText: undefined,
    sourcePath: undefined,
    changeKind: 'deleted'
  },
  {
    op: 'update',
    oldText: 'old\n',
    newText: 'new\n',
    sourcePath: 'previous.md',
    changeKind: 'renamed'
  }
])('preserves native $op file identity in existing Diff cards', (file) => {
  const [edit] = ompResolvedEdits({ ...changedFile, ...file }, 'edit')
  const [shown] =
    editFilesFromToolPair({
      name: 'Diff',
      input: { path: edit?.path },
      state: 'completed',
      result: { output: edit?.patch }
    }) ?? []
  expect(shown).toMatchObject({ path: 'README.md', changeKind: file.changeKind })
})

it('extracts resolved native edits inside mounted tools and printed Eval results alongside background work', async () => {
  const h = await setupOmpRpcAdapter()
  h.connection.receive({ type: 'agent_start' })
  const frame = {
    type: 'tool_execution_end',
    toolCallId: 'eval-1',
    toolName: 'eval',
    result: {
      content: [],
      details: {
        cells: [
          {
            views: [
              {
                view: {
                  kind: 'json',
                  value: [
                    { details: changedFile },
                    { details: { async: { jobId: 'bg_100', type: 'bash', state: 'running' } } }
                  ]
                }
              }
            ]
          }
        ]
      }
    }
  }
  h.connection.receive(frame)
  h.connection.receive(frame)
  h.connection.receive({
    type: 'tool_execution_update',
    toolCallId: 'later-eval',
    toolName: 'eval',
    partialResult: frame.result
  })
  const rows = await h.rig.rows()
  expect(rows.filter((row) => row.body.kind === 'diff')).toHaveLength(2)
  expect(h.childWork.mock.calls.flatMap(([entries]) => entries)).toContainEqual(
    expect.objectContaining({
      type: 'live',
      child: expect.objectContaining({ handle: expect.objectContaining({ id: 'omp-job:bg_100' }) })
    })
  )
  expect(
    ompResolvedEdits({ xdev: { tool: 'edit', mode: 'execute', inner: changedFile } }, 'write')
  ).toHaveLength(1)
})
