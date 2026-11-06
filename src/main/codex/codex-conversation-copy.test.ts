import type * as AppServerSession from './app-server/codex-app-server-session'
import type * as LocalHistory from '../native-chat/codex-local-history'
import type * as RolloutStream from '../native-chat/codex-rollout-history-stream'
import { readCodexLocalHistory } from '../native-chat/codex-local-history'
import { readCodexRolloutBytes } from '../native-chat/codex-rollout-history-stream'
import { mkdir, mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises'
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
function copy(selected = `${SOURCE}:a1`, settled = true) {
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
        settled
      }
    },
    {
      resolveLaunchArgs: () => ['--model', 'configured-model'],
      resolveWorkspacePath: async () => root,
      resolveCommand: () => ({ command: 'codex', prefixArgs: [] })
    }
  )
}

it('uses a persisted terminal canonical boundary for an idle imported latest reply with no live owner', async () => {
  await history(SOURCE, turn('canonical', 1))
  state.request.mockResolvedValue({ thread: { id: CHILD } })
  await expect(copy(undefined, false)).resolves.toEqual({ sessionId: CHILD })
  expect(state.initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'codex',
      args: [
        '--model',
        'saved-model',
        '-c',
        'approval_policy=never',
        '-c',
        'features.plugins=false',
        '-s',
        'read-only',
        '-a',
        'never',
        'app-server'
      ],
      cwd: root,
      env: { CODEX_HOME: root },
      timeoutMs: 60_000
    })
  )
  expect(state.request).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ cwd: root }))
  expect(state.request.mock.calls.map(([method]) => method)).toEqual(['thread/fork'])
  expect(state.request).toHaveBeenCalledWith(
    'thread/fork',
    expect.objectContaining({ lastTurnId: 'canonical' })
  )
})

it('uses beforeTurnId only for the immediate next effective root and opts into the experimental API', async () => {
  await history(SOURCE, [...turn(undefined, 1), ...turn('canonical-next', 2)])
  state.request.mockResolvedValue({ thread: { id: CHILD } })
  await copy()
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
  state.request.mockImplementation(async (method, params) => {
    if (method === 'thread/fork') {
      return { thread: { id: CHILD, historyMode: 'paginated' } }
    }
    expect(params?.threadId).toBe(CHILD)
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
  await expect(copy()).resolves.toEqual({ sessionId: CHILD })
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

it('refuses an unpaginated child when there is no canonical boundary', async () => {
  await history(SOURCE, turn(undefined, 1))
  state.request.mockResolvedValue({ thread: { id: CHILD, historyMode: 'legacy' } })
  await expect(copy()).rejects.toThrow('Codex could not locate an exact saved boundary')
  expect(state.request.mock.calls.map(([method]) => method)).toEqual(['thread/fork'])
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

it('reports a provider in-progress rejection without suggesting an update', async () => {
  await history(SOURCE, turn('canonical', 1))
  state.request.mockRejectedValue(new Error('Cannot fork thread with an in-progress turn'))
  await expect(copy()).rejects.toThrow('Wait for it to finish')
})

it.each([
  { count: 250, kept: 125, capturePages: 3, verificationPages: 2 },
  { count: 2500, kept: 1250, capturePages: 25, verificationPages: 13 }
])(
  'bounds fallback paging and rollout passes for $count turns',
  async ({ count, kept, capturePages, verificationPages }) => {
    const sourcePath = await history(
      SOURCE,
      Array.from({ length: count }, (_, index) => turn(undefined, index + 1)).flat()
    )
    const source = await readFile(sourcePath, 'utf8')
    const childPath = await history(CHILD, [])
    await writeFile(
      childPath,
      `${JSON.stringify({
        type: 'session_meta',
        ordinal: count * 2 + 1,
        payload: {
          id: CHILD,
          history_mode: 'paginated',
          history_base: {
            thread_id: SOURCE,
            end_ordinal_exclusive: count * 2 + 1,
            end_byte_offset: Buffer.byteLength(source)
          }
        }
      })}\n`
    )
    let reverted = false
    const pages = { capture: 0, verification: 0 }
    state.request.mockImplementation(async (method, params) => {
      if (method === 'thread/fork') {
        return { thread: { id: CHILD, historyMode: 'paginated' } }
      }
      expect(params?.threadId).toBe(CHILD)
      if (method === 'thread/revert') {
        expect(params?.beforeTurnId).toBe(`legacy-${kept + 1}`)
        reverted = true
        return { thread: { id: CHILD } }
      }
      expect(method).toBe('thread/turns/list')
      expect(params?.limit).toBe(100)
      expect(params?.sortDirection).toBe('asc')
      pages[reverted ? 'verification' : 'capture']++
      const offset = params?.cursor ? Number(params.cursor) : 0
      const end = Math.min(offset + 100, reverted ? kept : count)
      return {
        data: Array.from({ length: end - offset }, (_, index) => ({
          id: `legacy-${offset + index + 1}`
        })),
        nextCursor: end < (reverted ? kept : count) ? String(end) : null
      }
    })
    await expect(copy(`${SOURCE}:a${kept}`)).resolves.toEqual({ sessionId: CHILD })
    expect(pages).toEqual({ capture: capturePages, verification: verificationPages })
    expect(state.request.mock.calls.filter(([method]) => method === 'thread/revert')).toHaveLength(
      1
    )
    expect(vi.mocked(readCodexLocalHistory).mock.calls.map(([input]) => input.filePath)).toEqual([
      sourcePath,
      childPath
    ])
    // Each pass reads a header and a body; the child's pass also visits its source prefix.
    const streams = vi.mocked(readCodexRolloutBytes).mock.calls.map(([path]) => path)
    expect(streams).toHaveLength(6)
    const sourcePhysicalPath = await realpath(sourcePath)
    const childPhysicalPath = await realpath(childPath)
    expect(streams.filter((path) => path === sourcePhysicalPath)).toHaveLength(4)
    expect(streams.filter((path) => path === childPhysicalPath)).toHaveLength(2)
  }
)
