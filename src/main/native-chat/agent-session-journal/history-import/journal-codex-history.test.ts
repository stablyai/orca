import { createCodexHistoryCollector } from './journal-codex-history'
import { codexCommandPresentation } from '../../../codex/history/rollouts/codex-command-presentation'
import { codexRolloutItem } from '../../../codex/history/rollouts/codex-rollout-item-projection'
import { projectCodexHistoryItem } from '../../../codex/history/journal-views/codex-history-projection'
import { recordedCodexRollout } from '../../../codex/__fixtures__/codex-rollout-recordings'
import { chat } from '../../../codex/structured/threads/codex-thread-catch-up-contract-test-fixture'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { nativeChatToolLineLabel } from '../../../../shared/native-chat/tools/native-chat-tool-line-label'
import { nativeChatToolRunOutcome } from '../../../../shared/native-chat/tools/native-chat-tool-run-outcome'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeCodexHistoryFixture } from './codex-history-test-fixture'
import {
  prepareLegacyTranscriptImport,
  importLegacyTranscriptIntoJournal
} from './journal-legacy-import'

const PARENT = '01a17c7f-6f58-7a73-b87a-a8702ff2da17'
const CHILD = '01a17c81-30d1-72f0-b84e-002ddfe6fd47'
const MIDDLE = '01a17c80-30d1-72f0-b84e-002ddfe6fd47'
let root: string
beforeEach(async () => {
  const account = await mkdtemp(join(tmpdir(), 'orca-codex-lineage-'))
  root = join(account, 'sessions')
  await mkdir(root)
  await mkdir(join(account, 'archived_sessions'))
})
afterEach(async () => {
  await rm(dirname(root), { recursive: true, force: true })
})

function request(filePath: string) {
  return {
    agent: 'codex' as const,
    sessionId: CHILD,
    options: {
      filePath,
      codexSessionsDirs: [root],
      source: { providerSessionId: CHILD, workspaceCwd: '/workspace' }
    }
  }
}

it.each(['active', 'archive', 'compressed'] as const)(
  'imports %s ancestor prefixes oldest first and excludes later turns',
  async (location) => {
    const parent = await writeCodexHistoryFixture(root, PARENT, ['sky'], undefined, MIDDLE)
    const middle = await writeCodexHistoryFixture(root, MIDDLE, ['leaves'], parent.position)
    const child = await writeCodexHistoryFixture(root, CHILD, ['ice'], middle.position)
    const later = await writeCodexHistoryFixture(root, '01a17c82-30d1-72f0-b84e-002ddfe6fd47', [
      'S1'
    ])
    await appendFile(
      parent.filePath,
      `${later.records
        .slice(1)
        .map((record, index) =>
          JSON.stringify({ ...record, ordinal: parent.position.end_ordinal_exclusive + index })
        )
        .join('\n')}\n`
    )
    if (location !== 'active') {
      const archived = join(dirname(root), 'archived_sessions', basename(parent.filePath))
      if (location === 'compressed') {
        await writeFile(`${archived}.zst`, zstdCompressSync(await readFile(parent.filePath)))
        await rm(parent.filePath)
      } else {
        await rename(parent.filePath, archived)
      }
    }
    const result = await prepareLegacyTranscriptImport(request(child.filePath))
    expect(result.ok && result.items.map((item) => item.body)).toMatchObject([
      { blocks: [{ text: 'sky' }] },
      { blocks: [{ text: 'sky answer' }] },
      { blocks: [{ text: 'leaves' }] },
      { blocks: [{ text: 'leaves answer' }] },
      { blocks: [{ text: 'ice' }] },
      { blocks: [{ text: 'ice answer' }] }
    ])
  }
)

it.each(['a', 'b', 'r24'] as const)(
  'imports recorded %s executions and interrupted presentation durably',
  async (label) => {
    const records = await recordedCodexRollout(label)
    const c = await chat({ now: 1_800_000_000_000 })
    const filePath = join(root, `rollout-${String(records[0]!.payload.id)}.jsonl`)
    await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
    const imported = await importLegacyTranscriptIntoJournal({
      journal: c.journal,
      agent: 'codex',
      sessionId: 'recorded',
      fence: 1,
      options: { filePath }
    })
    expect(imported.ok).toBe(true)
    const snapshot = c.journal.snapshot()
    const calls = snapshot.items.filter((row) => row.body.kind === 'tool-call')
    expect(calls).toHaveLength(label === 'a' ? 4 : label === 'b' ? 3 : 1)
    const blocks = projectStructuredItemsToNativeChat(snapshot.items).flatMap(
      (message) => message.blocks
    )
    expect(nativeChatToolRunOutcome(blocks, {})).toMatchObject({
      failedCallCount: label === 'r24' ? 0 : 1,
      interruptedCallCount: label === 'b' ? 2 : 1
    })
    const interrupted = calls.filter(
      (row) => row.body.kind === 'tool-call' && row.body.endedAs === 'interrupted'
    )
    for (const row of interrupted) {
      expect(row.body).not.toHaveProperty('exitCode')
      expect(row.body).not.toHaveProperty('durationMs')
      expect(row.body).not.toHaveProperty('output')
      const block = blocks.find(
        (block) =>
          block.type === 'tool-call' &&
          block.callId === (row.body.kind === 'tool-call' && row.body.callId)
      )
      expect(block).toMatchObject({ type: 'tool-call', state: 'failed', endedAs: 'interrupted' })
      expect(block).not.toHaveProperty('exitCode')
      expect(block).not.toHaveProperty('durationMs')
      expect(block?.type === 'tool-call' && nativeChatToolLineLabel(block).verb).toBeNull()
      expect(
        blocks.some(
          (block) =>
            block.type === 'tool-result' &&
            block.callId === (row.body.kind === 'tool-call' && row.body.callId)
        )
      ).toBe(false)
    }
    expect(
      snapshot.items.some((row) => row.body.kind === 'message' && row.body.role === 'tool')
    ).toBe(false)
    expect(JSON.stringify(blocks)).not.toContain('Conversation interrupted')
    if (label === 'a') {
      expect(interrupted[0]!.body).toEqual({
        kind: 'tool-call',
        name: 'shell',
        callId: 'exec-422971fb-5f49-4f00-8701-a031ef77f289',
        input: {
          command: "/bin/zsh -lc 'sleep 60'",
          cwd: '/Users/brennanbenson/orca/workspaces/orca/qa-codex-exec-import-qg/codex-exec-import/run/workspace'
        },
        state: 'failed',
        endedAs: 'interrupted'
      })
      expect(
        calls.find((row) => row.body.kind === 'tool-call' && row.body.exitCode === 7)?.body
      ).toMatchObject({ exitCode: 7, durationMs: 0, state: 'failed' })
      expect(calls[0]!.body).toEqual({
        kind: 'tool-call',
        name: 'shell',
        callId: 'exec-9e16b5a2-aa91-41ce-9694-3d5ffbe84745',
        input: {
          command:
            "/bin/zsh -lc \"printf '%s\\\\n' \\\"qa a'b\\\" 'C:\\\\qa\\\\path' 'Authorization: Bearer [REDACTED_SECRET]'\"",
          cwd: '/Users/brennanbenson/orca/workspaces/orca/qa-codex-exec-import-qg/codex-exec-import/run/workspace'
        },
        state: 'completed',
        exitCode: 0,
        durationMs: 0,
        output: {
          head: "qa a'b\nC:\\qa\\path\nAuthorization: Bearer abcdefghijklmnop\n",
          byteLength: 57,
          digest: '61e992d1a5db513bbd4cf6fdea649f50b73db4b68b12532905e034b4ccc19458',
          truncated: false
        }
      })
    }
    const turns = snapshot.items.filter((row) => row.body.kind === 'turn')
    expect(turns.at(-1)?.body).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation',
      durationMs: label === 'a' ? 21244 : label === 'b' ? 11362 : 7678
    })
    if (label === 'b') {
      expect(turns.map((row) => row.body.kind === 'turn' && row.body.state)).toEqual([
        'completed',
        'completed',
        'interrupted'
      ])
      expect(calls[1]?.body).toMatchObject({
        callId: 'exec-b421ed59-e65b-4311-acc8-685624133938',
        endedAs: 'interrupted'
      })
      expect(calls[1]?.turnScope).toEqual({
        kind: 'turn',
        turnItemId: 'legacy:codex:recorded:turn-lifecycle%3A01a1b0e1-897d-73e0-b910-5b854abbfcb7'
      })
      expect(calls[0]?.body).toMatchObject({ exitCode: 7, durationMs: 11872, state: 'failed' })
      expect(calls[0]?.body).not.toHaveProperty('endedAs')
    }
    await c.reopen()
    expect(c.journal.snapshot()).toEqual(snapshot)
  }
)

it('imports recorded patch revisions and parsed read through canonical bodies', async () => {
  const records = await recordedCodexRollout('c')
  const filePath = join(root, `rollout-${String(records[0]!.payload.id)}.jsonl`)
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
  const result = await prepareLegacyTranscriptImport({
    agent: 'codex',
    sessionId: 'recorded',
    options: { filePath }
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    return
  }
  const patches = result.items.filter((row) => row.body.kind === 'diff')
  expect(patches.map((row) => row.body.kind === 'diff' && row.body.patch.head)).toEqual([
    'before\n',
    '@@ -1 +1 @@\n-before\n+after\n'
  ])
  expect(result.items.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
    name: 'read',
    state: 'completed',
    input: {
      path: '/Users/brennanbenson/orca/workspaces/orca/qa-codex-exec-import-qg/codex-exec-import/run/workspace/codex-exec-import-sample.txt'
    },
    output: { head: 'after\n' }
  })
})

it('matches the provider quoting/redaction and classification contracts', () => {
  for (const [cwd, path, expected] of [
    ['file:///C:/workspace/src', 'D:\\tmp\\test.rs', 'D:/tmp/test.rs'],
    ['file:///C:/workspace/src', '..\\tests/file.rs', 'C:/workspace/tests/file.rs'],
    ['file:///workspace', 'literal\\name', '/workspace/literal\\name']
  ]) {
    const body = projectCodexHistoryItem(
      codexRolloutItem({
        type: 'CommandExecution',
        id: 'read-path-contract',
        command: ['cat', path],
        cwd,
        parsed_cmd: [{ type: 'read', cmd: 'cat', name: path, path }],
        status: 'completed'
      })!
    )
    expect(body).toMatchObject({ kind: 'tool-call', input: { path: expected } })
  }
  for (const [argv, expected] of [
    [[], ''],
    [[''], "''"],
    [["a'b"], `"a'b"`],
    [['a\\b'], '"a\\\\b"'],
    [['é'], "'é'"],
    [['^^'], "'^''^'"],
    [['a\0b'], '<command included NUL byte>'],
    [['Bearer abcdefghijklmnop'], "'Bearer [REDACTED_SECRET]'"],
    [['éBearer abcdefghijklmnop'], "'éBearer abcdefghijklmnop'"],
    [['sk-abcdefghijklmnopqrst'], '[REDACTED_SECRET]'],
    [['AKIAABCDEFGHIJKLMNOP'], '[REDACTED_SECRET]'],
    [['token=abcdefgh'], "'token=[REDACTED_SECRET]'"],
    [['token\u0085=abcdefgh'], "'token\u0085=[REDACTED_SECRET]'"],
    [['Bearer\u00a0abcdefghijklmnop'], "'Bearer\u00a0abcdefghijklmnop'"]
  ] satisfies [string[], string][]) {
    expect(codexCommandPresentation(argv)).toBe(expected)
  }
  expect(
    projectCodexHistoryItem(codexRolloutItem({ type: 'SubAgentActivity', id: 'hidden' })!)
  ).toBeNull()
  expect(
    projectCodexHistoryItem(
      codexRolloutItem({ type: 'Extension', kind: 'clock.sleep', id: 'hidden' })!
    )
  ).toBeNull()
})

it('does not regain first-terminal proof after eviction, replay or a new task start (protocol contracts)', async () => {
  const source = await recordedCodexRollout('a')
  const abort = source.at(-2)!,
    closure = source.at(-1)!
  const collect = (records: typeof source, budget = 16 * 1024 * 1024) => {
    const collector = createCodexHistoryCollector('bounded', { inlineHeadBytes: 1024 }, budget)
    records.forEach((record, ordinal) =>
      collector.record({
        record,
        ordinal,
        segmentId: 'physical',
        paginated: true,
        offset: ordinal,
        selected: true,
        recordId: `physical:${String((record.payload.item as { id?: string } | undefined)?.id ?? ordinal)}`
      })
    )
    return collector.items()
  }
  const project = (records: typeof source, budget?: number) =>
    collect(records, budget).find(
      (row) =>
        row.body.kind === 'tool-call' &&
        row.body.callId === 'exec-422971fb-5f49-4f00-8701-a031ef77f289'
    )?.body
  const turnBody = (records: typeof source) =>
    collect(records).find((row) => row.body.kind === 'turn')?.body
  const unfinished = turnBody(source.slice(0, 2))
  expect(unfinished).toMatchObject({ state: 'completed' })
  expect(unfinished).not.toHaveProperty('outcome')
  expect(unfinished).not.toHaveProperty('completedAt')
  for (const reason of [undefined, 'other']) {
    const otherAbort = { ...abort, payload: { ...abort.payload, reason } }
    expect(turnBody([...source.slice(0, -2), otherAbort])).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(project([...source.slice(0, -2), otherAbort, closure])).toMatchObject({
      state: 'failed',
      exitCode: -1
    })
  }
  const failedTurn = {
    ...abort,
    payload: { ...abort.payload, type: 'task_complete', error: { message: 'protocol failure' } }
  }
  expect(turnBody([...source.slice(0, -2), failedTurn])).toMatchObject({
    state: 'completed',
    outcome: 'failure'
  })
  expect(project(source)).toMatchObject({ endedAs: 'interrupted' })
  expect(project([...source.slice(0, -2), closure, abort, closure])).toMatchObject({
    state: 'failed',
    exitCode: -1
  })
  const next = {
    ...source[1]!,
    timestamp: '2026-11-06T12:39:21.570Z',
    payload: { type: 'task_started', turn_id: 'next' }
  }
  expect(project([...source.slice(0, -1), next, closure])).toMatchObject({
    state: 'failed',
    exitCode: -1
  })
  expect(project([...source, next, closure])).toMatchObject({ endedAs: 'interrupted' })
  const churn = Array.from({ length: 30 }, (_, n) => ({
    ...source[5]!,
    payload: {
      ...source[5]!.payload,
      item: { ...(source[5]!.payload.item as object), id: `evict-${n}` }
    }
  }))
  expect(project([...source.slice(0, -2), closure, ...churn, abort, closure], 4096)).toMatchObject({
    state: 'failed',
    exitCode: -1
  })
  const running = {
    ...closure,
    payload: {
      ...closure.payload,
      item: { ...(closure.payload.item as object), status: 'in_progress', exit_code: null }
    }
  }
  expect(project([...source.slice(0, -2), running])).toMatchObject({ state: 'running' })
  const missingTime = { ...closure, payload: { ...closure.payload, started_at_ms: undefined } }
  expect(project([...source.slice(0, -1), missingTime])).toMatchObject({
    state: 'failed',
    exitCode: -1
  })
  const legacy = source.map((record, index) =>
    index === 0 ? { ...record, payload: { ...record.payload, history_mode: 'full' } } : record
  )
  const filePath = join(root, 'legacy.jsonl')
  await writeFile(filePath, legacy.map((record) => JSON.stringify(record)).join('\n'))
  const imported = await prepareLegacyTranscriptImport({
    agent: 'codex',
    sessionId: 'legacy',
    options: { filePath }
  })
  expect(imported.ok && imported.items.filter((row) => row.body.kind === 'tool-call')).toHaveLength(
    5
  )
})
