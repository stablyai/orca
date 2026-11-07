import { recordedCodexRollout } from './__fixtures__/codex-rollout-recordings'
import type * as AppServerSession from './app-server/codex-app-server-session'
import type * as LocalHistory from '../native-chat/codex-local-history'
import type * as RolloutStream from '../native-chat/codex-rollout-history-stream'
import { readCodexLocalHistory } from '../native-chat/codex-local-history'
import { readCodexRolloutBytes } from '../native-chat/codex-rollout-history-stream'
import { appendFile, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { copyCodexConversation, codexForkHistory } from './codex-conversation-copy'
import type { CodexAppServerRpc } from './app-server/codex-app-server-session'

const state = vi.hoisted(() => ({
  home: '',
  paths: new Map<string, string>(),
  request: vi.fn<CodexAppServerRpc['request']>(),
  initialize: vi.fn()
}))
vi.mock('../native-chat/codex-local-history', async (importOriginal) => {
  const original = await importOriginal<typeof LocalHistory>()
  return { ...original, readCodexLocalHistory: vi.fn(original.readCodexLocalHistory) }
})
vi.mock('../native-chat/codex-rollout-history-stream', async (importOriginal) => {
  const original = await importOriginal<typeof RolloutStream>()
  return { ...original, readCodexRolloutBytes: vi.fn(original.readCodexRolloutBytes) }
})
vi.mock('../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: async (_agent: string, id: string) => state.paths.get(id) ?? null
}))
vi.mock('./app-server/codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AppServerSession>()),
  runCodexAppServerSession: async (
    launch: unknown,
    body: (rpc: CodexAppServerRpc) => Promise<unknown>
  ) => {
    state.initialize(launch)
    return body({ request: state.request, notify: () => {} })
  }
}))

const SOURCE = '00000000-0000-4000-8000-000000000001'
const CHILD = '00000000-0000-4000-8000-000000000002'
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-fork-codex-'))
  state.home = root
  state.paths.clear()
  state.request.mockReset()
  state.initialize.mockReset()
  vi.mocked(readCodexLocalHistory).mockClear()
  vi.mocked(readCodexRolloutBytes).mockClear()
  await mkdir(join(root, 'sessions'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

function message(type: 'UserMessage' | 'AgentMessage', id: string) {
  return {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type, id, content: [{ type: 'text', text: 'repeated identical prompt' }] }
    }
  }
}
function turn(id: string | undefined, n: number) {
  return [
    ...(id ? [{ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }] : []),
    message('UserMessage', `u${n}`),
    message('AgentMessage', `a${n}`),
    ...(id ? [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }] : [])
  ]
}
async function history(id: string, records: object[]) {
  const path = join(root, 'sessions', `rollout-2026-11-04T00-00-00-${id}.jsonl`)
  await writeFile(
    path,
    `${[{ type: 'session_meta', payload: { id, history_mode: 'paginated' } }, ...records].map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join('\n')}\n`
  )
  state.paths.set(id, path)
  return path
}
function copy(selected = `${SOURCE}:a1`, settled = true, turnId?: string) {
  return copyCodexConversation(
    {
      record: agentSessionRecordFixture({
        sessionId: 'orca-source',
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: root },
        launchArgs: ['--model', 'saved-model']
      }),
      identity: {
        sessionId: 'orca-source',
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: null
      },
      providerSessionId: SOURCE,
      title: 'Source fork',
      accountHome: { variable: 'CODEX_HOME', path: root },
      checkpoint: {
        selectedItemId: agentJournalItemKey({
          provider: 'legacy',
          agent: 'codex',
          sessionId: SOURCE,
          recordId: selected
        }),
        settled,
        ...(turnId ? { turnId } : {})
      }
    },
    {
      resolveLaunchArgs: () => ['--model', 'configured-model'],
      resolveWorkspacePath: async () => root,
      resolveCommand: () => ({ command: 'codex', prefixArgs: [] })
    }
  )
}

async function childPrefix(lines?: number) {
  const source = `${(await readFile(state.paths.get(SOURCE)!, 'utf8'))
    .trimEnd()
    .split('\n')
    .slice(0, lines)
    .join('\n')}\n`
  const count = source.trim().split('\n').length
  const path = await history(CHILD, [])
  await writeFile(
    path,
    `${JSON.stringify({
      ordinal: count,
      type: 'session_meta',
      payload: {
        id: CHILD,
        history_mode: 'paginated',
        history_base: {
          thread_id: SOURCE,
          end_ordinal_exclusive: count,
          end_byte_offset: Buffer.byteLength(source)
        }
      }
    })}\n`
  )
  return path
}

it('uses a persisted terminal canonical boundary for an idle imported latest reply with no live owner', async () => {
  await history(SOURCE, turn('canonical', 1))
  await childPrefix()
  state.request.mockResolvedValue({ thread: { id: CHILD } })
  await expect(copy(undefined, false)).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['canonical'] }
  })
  expect(state.request).toHaveBeenCalledWith(
    'thread/fork',
    expect.objectContaining({ lastTurnId: 'canonical' })
  )
})

it('uses beforeTurnId only for the immediate next effective root and opts into the experimental API', async () => {
  await history(SOURCE, [...turn(undefined, 1), ...turn('canonical-next', 2)])
  await childPrefix(3)
  state.request.mockImplementation(async (method) =>
    method === 'thread/fork'
      ? { thread: { id: CHILD } }
      : { data: [{ id: 'legacy-first' }, { id: 'canonical-next' }], nextCursor: null }
  )
  await expect(copy()).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['legacy-first'] }
  })
  expect(state.request).toHaveBeenCalledWith(
    'thread/fork',
    expect.objectContaining({ beforeTurnId: 'canonical-next' })
  )
  expect(state.initialize).toHaveBeenCalledWith(expect.objectContaining({ experimentalApi: true }))
})

it('forks and reverts only the child for legacy, legacy, canonical, counting against the captured child', async () => {
  const records = [...turn(undefined, 1), ...turn(undefined, 2), ...turn('canonical-third', 3)]
  await history(SOURCE, records)
  const source = await readFile(state.paths.get(SOURCE)!, 'utf8')
  const path = join(root, 'sessions', `rollout-2026-11-04T00-00-00-${CHILD}.jsonl`)
  const count = source.trim().split('\n').length
  await writeFile(
    path,
    `${JSON.stringify({ ordinal: count, type: 'session_meta', payload: { id: CHILD, history_mode: 'paginated', history_base: { thread_id: SOURCE, end_ordinal_exclusive: count, end_byte_offset: Buffer.byteLength(source) } } })}\n`
  )
  state.paths.set(CHILD, path)
  let reverted = false
  state.request.mockImplementation(async (method) => {
    if (method === 'thread/fork') {
      return { thread: { id: CHILD, historyMode: 'paginated' } }
    }
    if (method === 'thread/name/set') {
      return {}
    }
    if (method === 'thread/revert') {
      reverted = true
      return { thread: { id: CHILD } }
    }
    return {
      data: (reverted ? ['legacy-1'] : ['legacy-1', 'legacy-2', 'canonical-third']).map((id) => ({
        id
      })),
      nextCursor: null
    }
  })
  await expect(copy()).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['legacy-1'] }
  })
  expect(state.request).toHaveBeenCalledWith('thread/revert', {
    threadId: CHILD,
    beforeTurnId: 'legacy-2'
  })
  expect(state.request).toHaveBeenCalledWith('thread/fork', {
    threadId: SOURCE,
    excludeTurns: true,
    cwd: root
  })
})

it('uses exact physical identities across repeated prompts rather than a retained-window offset', async () => {
  const path = await history(SOURCE, [
    ...turn('first', 1),
    ...turn('second', 2),
    ...turn('third', 3)
  ])
  const result = await codexForkHistory({
    path,
    roots: [join(root, 'sessions')],
    sessionId: SOURCE,
    selectedItemId: agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: SOURCE,
      recordId: `${SOURCE}:a2`
    })
  })
  expect(result.index).toBe(1)
  expect(result.selected.id).toBe('second')
})

it('freezes all-unrecorded root IDs on the source, excluding child replacements and later source growth', async () => {
  await history(SOURCE, [...turn(undefined, 1), ...turn(undefined, 2), ...turn(undefined, 3)])
  let reverted = false
  state.request.mockImplementation(async (method, params) => {
    if (method === 'thread/fork') {
      await history(SOURCE, [
        ...turn(undefined, 1),
        ...turn(undefined, 2),
        ...turn(undefined, 3),
        ...turn(undefined, 4)
      ])
      const path = await childPrefix()
      await appendFile(
        path,
        `${JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'child-only' }
        })}\n`
      )
      return { thread: { id: CHILD, historyMode: 'paginated' } }
    }
    if (method === 'thread/revert') {
      reverted = true
      return { thread: { id: CHILD } }
    }
    return {
      data: (params?.threadId === SOURCE
        ? ['S1', 'S2', 'S3']
        : reverted
          ? ['S1']
          : ['S1', 'C2', 'C3', 'C4']
      ).map((id) => ({ id })),
      nextCursor: null
    }
  })
  await expect(copy()).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['S1'] }
  })
})

it('certifies recorded turns in a standalone copied rollout with no physical history base', async () => {
  const rows = await recordedCodexRollout('c')
  const source = rows.find((row) => row.type === 'session_meta')!
  const started = rows.find(
    (row) => row.type === 'event_msg' && row.payload.type === 'task_started'
  )!
  const through = rows.findIndex(
    (row) => row.type === 'event_msg' && row.payload.type === 'task_complete'
  )
  const captured = rows.slice(0, through + 1)
  for (const [id, meta] of [
    [SOURCE, source],
    [CHILD, source]
  ] as const) {
    const path = await history(id, [])
    const serialized = captured
      .map((row) =>
        JSON.stringify(row === meta ? { ...row, payload: { ...row.payload, id } } : row)
      )
      .join('\n')
    await writeFile(path, `${serialized}\n`)
  }
  state.request.mockResolvedValue({ thread: { id: CHILD } })
  await expect(copy(undefined, true, String(started.payload.turn_id))).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['01a1b0d7-ac1d-7e00-85b8-806a4d8d494b'] }
  })
})
