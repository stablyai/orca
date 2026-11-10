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
import { copyCodexConversation } from './codex-conversation-copy'
import { codexForkHistory } from './codex-fork-history'
import { CodexAppServerTimeoutError } from './app-server/codex-app-server-session'
import type { CodexAppServerRpc } from './app-server/codex-app-server-session'

const state = vi.hoisted(() => {
  const session: {
    run?: (body: (rpc: CodexAppServerRpc) => Promise<unknown>) => Promise<unknown>
    transport?: 'native' | 'unsupported-read'
  } = {}
  return {
    home: '',
    paths: new Map<string, string>(),
    request: vi.fn<CodexAppServerRpc['request']>(),
    initialize: vi.fn(),
    session
  }
})
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
vi.mock('./app-server/codex-app-server-session', async (importOriginal) => {
  const original = await importOriginal<typeof AppServerSession>()
  return {
    ...original,
    runCodexAppServerSession: async (
      launch: AppServerSession.CodexAppServerInvocation,
      body: (rpc: CodexAppServerRpc) => Promise<unknown>
    ) => {
      state.initialize(launch)
      if (state.session.transport) {
        const server = String.raw`
          let experimental = false
          require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const message = JSON.parse(line)
            if (typeof message.id !== 'number') return
            if (message.method === 'initialize') {
              experimental = message.params.capabilities?.experimentalApi === true
            }
            const error = message.method === 'thread/read' && process.argv[1] === 'unsupported-read'
              ? { code: -32601, message: 'thread/read is not supported yet' }
              : message.method === 'thread/turns/list' && !experimental
                ? { code: -32600, message: 'thread/turns/list requires experimentalApi capability' }
                : null
            process.stdout.write(JSON.stringify({ id: message.id, ...(error ? { error } : { result: {} }) }) + '\n')
          })
        `
        return original.runCodexAppServerSession(
          {
            ...launch,
            command: process.execPath,
            args: ['-e', server, state.session.transport],
            cliPath: null
          },
          (rpc) =>
            body({
              ...rpc,
              request: async (method, params) => {
                await rpc.request(method, params)
                return state.request(method, params)
              }
            })
        )
      }
      return state.session.run
        ? state.session.run(body)
        : body({ request: state.request, notify: () => {} })
    }
  }
})

const SOURCE = '01a1bdd2-6d33-7a21-9a1d-c14f0117bc8c'
const CHILD = '01a1bde0-5ded-7f03-a1bf-3dae1613d8c7'
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-fork-codex-'))
  state.home = root
  state.paths.clear()
  state.request.mockReset()
  state.session.run = undefined
  state.session.transport = undefined
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
function copy(
  selected = `${SOURCE}:a1`,
  settled = true,
  turnId?: string,
  options: { signal?: AbortSignal; selectedItemId?: string } = {}
) {
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
      signal: options.signal,
      title: 'Source fork',
      accountHome: { variable: 'CODEX_HOME', path: root },
      checkpoint: {
        selectedItemId:
          options.selectedItemId ??
          agentJournalItemKey({
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

it('keeps omitted-mode compatibility for a persisted terminal imported reply', async () => {
  await history(SOURCE, turn('canonical', 1))
  await childPrefix()
  state.request.mockImplementation(async (method) => ({
    thread: { id: method === 'thread/read' ? SOURCE : CHILD }
  }))
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
    method === 'thread/read'
      ? { thread: { id: SOURCE, historyMode: 'paginated' } }
      : method === 'thread/fork'
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
    if (method === 'thread/read') {
      return { thread: { id: SOURCE, historyMode: 'paginated' } }
    }
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

it('keeps method-not-found compatibility with frozen unrecorded IDs despite source growth and child replacements', async () => {
  state.session.transport = 'unsupported-read'
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

it('keeps legacy-mode compatibility for recorded turns in a standalone copied rollout', async () => {
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
  state.request.mockImplementation(async (method) => ({
    thread: { id: method === 'thread/read' ? SOURCE : CHILD, historyMode: 'legacy' }
  }))
  await expect(copy(undefined, true, String(started.payload.turn_id))).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['01a1b0d7-ac1d-7e00-85b8-806a4d8d494b'] }
  })
})

it('forks the current paged native prefix after rewind without source or child rollout authority', async () => {
  state.session.transport = 'native'
  await history(SOURCE, [
    ...turn('01a1bdd2-6d5e-7960-8fbb-30c962a5eeaa', 1),
    ...turn('01a1bdd3-1293-7bc2-b750-017ca47738f9', 2)
  ])
  const selected = '01a1bdd4-2977-7f81-8495-eb160b46419a'
  state.request.mockImplementation(async (method, params) => {
    if (method === 'thread/read') {
      return { thread: { id: SOURCE, historyMode: 'paginated', status: { type: 'notLoaded' } } }
    }
    if (method === 'thread/fork') {
      return { thread: { id: CHILD, historyMode: 'paginated' } }
    }
    if (!params?.cursor) {
      return {
        data: [{ id: '01a1bdd2-6d5e-7960-8fbb-30c962a5eeaa', status: 'completed' }],
        nextCursor: 'page-2'
      }
    }
    return {
      data: [
        { id: '01a1bdd2-b7a1-7c63-8b19-cc361c2baefb', status: 'completed' },
        { id: selected, status: 'completed' },
        ...(params.threadId === CHILD
          ? [{ id: '01a1bde0-5e1e-7ad0-ab18-f9ed07fd00e7', status: 'completed' }]
          : [])
      ],
      nextCursor: null
    }
  })
  await expect(
    copy(undefined, false, selected, { selectedItemId: `codex:${SOURCE}:${selected}:1` })
  ).resolves.toEqual({
    sessionId: '01a1bde0-5ded-7f03-a1bf-3dae1613d8c7',
    coverage: {
      unit: 'codex-turn',
      ids: [
        '01a1bdd2-6d5e-7960-8fbb-30c962a5eeaa',
        '01a1bdd2-b7a1-7c63-8b19-cc361c2baefb',
        '01a1bdd4-2977-7f81-8495-eb160b46419a'
      ]
    }
  })
  expect(state.request).toHaveBeenCalledWith('thread/fork', {
    threadId: SOURCE,
    lastTurnId: '01a1bdd4-2977-7f81-8495-eb160b46419a',
    excludeTurns: true,
    cwd: root
  })
})

it('bridges a saved physical reply with an absent command candidate without restoring a removed native turn', async () => {
  await history(SOURCE, [...turn('kept', 1), ...turn('removed', 2)])
  state.request.mockImplementation(async (method) => {
    if (method === 'thread/read') {
      return { thread: { id: SOURCE, historyMode: 'paginated' } }
    }
    if (method === 'thread/fork') {
      return { thread: { id: CHILD } }
    }
    return { data: [{ id: 'kept', status: 'completed' }], nextCursor: null }
  })
  await expect(copy(undefined, true, 'orca-command')).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['kept'] }
  })
  await expect(copy(`${SOURCE}:a2`, true, 'orca-command')).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' },
      createAttemptRefusedBeforeCommit: true
    }
  })
  await expect(copy(undefined, true)).resolves.toEqual({
    sessionId: CHILD,
    coverage: { unit: 'codex-turn', ids: ['kept'] }
  })
  await expect(
    copy(undefined, true, 'removed', { selectedItemId: `codex:${SOURCE}:removed:1` })
  ).rejects.toMatchObject({
    refusal: {
      details: { reason: 'savedConversationMissing' },
      createAttemptRefusedBeforeCommit: true
    }
  })
})

it('keeps read faults in preparation and a contradictory copied prefix uncertain', async () => {
  const selected = '01a1bdd4-2977-7f81-8495-eb160b46419a'
  await history(SOURCE, turn(selected, 1))
  await childPrefix()
  const prepare = () => copy(undefined, true, selected)
  state.request.mockRejectedValue(new Error('read failed'))
  await expect(prepare()).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' },
      createAttemptRefusedBeforeCommit: true
    }
  })
  state.request.mockResolvedValue({ thread: { id: CHILD, historyMode: 'paginated' } })
  await expect(prepare()).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' },
      createAttemptRefusedBeforeCommit: true
    }
  })
  state.request.mockImplementation(async (method, params) => {
    if (method === 'thread/read') {
      return { thread: { id: SOURCE, historyMode: 'paginated' } }
    }
    if (method === 'thread/fork') {
      return { thread: { id: CHILD } }
    }
    return {
      data: (params?.threadId === SOURCE
        ? ['01a1bdd2-6d5e-7960-8fbb-30c962a5eeaa', selected]
        : [selected, '01a1bdd2-6d5e-7960-8fbb-30c962a5eeaa']
      ).map((id) => ({
        id
      })),
      nextCursor: null
    }
  })
  await expect(prepare()).rejects.not.toHaveProperty('refusal')
})

it('refuses invalid and repeated source cursors before copying', async () => {
  state.request.mockImplementation(async (method) =>
    method === 'thread/read'
      ? { thread: { id: SOURCE, historyMode: 'paginated' } }
      : { data: [{ id: 'first' }], nextCursor: 'same-page' }
  )
  await expect(copy(undefined, true, 'missing')).rejects.toMatchObject({
    refusal: { details: { reason: 'transcriptUnreadable' }, createAttemptRefusedBeforeCommit: true }
  })
  state.request.mockImplementation(async (method) =>
    method === 'thread/read'
      ? { thread: { id: SOURCE, historyMode: 'paginated' } }
      : { data: [], nextCursor: 17 }
  )
  await expect(copy(undefined, true, 'missing')).rejects.toMatchObject({
    refusal: { details: { reason: 'transcriptUnreadable' }, createAttemptRefusedBeforeCommit: true }
  })
})

it('cannot dispatch an abandoned preparation after its lifetime ends, but keeps an invoked fork uncertain', async () => {
  const listed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<unknown>()
  const expired = Promise.withResolvers<never>()
  const lifetime = new AbortController()
  let abandoned: Promise<unknown> | undefined
  let childCreated = false
  state.request.mockImplementation(async (method) => {
    if (method === 'thread/read') {
      return { thread: { id: SOURCE, historyMode: 'paginated' } }
    }
    if (method === 'thread/fork') {
      childCreated = true
      return { thread: { id: CHILD } }
    }
    listed.resolve()
    return release.promise
  })
  state.session.run = async (body) => {
    abandoned = body({ request: state.request, notify: () => {}, signal: lifetime.signal })
    return Promise.race([abandoned, expired.promise])
  }
  const preparation = copy(undefined, true, 'selected')
  await listed.promise
  lifetime.abort(new CodexAppServerTimeoutError('session ended'))
  expired.reject(lifetime.signal.reason)
  await expect(preparation).rejects.toMatchObject({
    refusal: { createAttemptRefusedBeforeCommit: true }
  })
  release.resolve({ data: [{ id: 'selected' }], nextCursor: null })
  await expect(abandoned).rejects.toBe(lifetime.signal.reason)
  expect(childCreated).toBe(false)
  const forked = Promise.withResolvers<void>()
  const lost = Promise.withResolvers<never>()
  const pending = Promise.withResolvers<unknown>()
  state.session.run = async (body) =>
    Promise.race([body({ request: state.request, notify: () => {} }), lost.promise])
  state.request.mockImplementation(async (method) => {
    if (method === 'thread/read') {
      return { thread: { id: SOURCE, historyMode: 'paginated' } }
    }
    if (method === 'thread/fork') {
      forked.resolve()
      return pending.promise
    }
    return { data: [{ id: 'selected' }], nextCursor: null }
  })
  const invoked = copy(undefined, true, 'selected')
  await forked.promise
  const timeout = new CodexAppServerTimeoutError('reply lost')
  lost.reject(timeout)
  await expect(invoked).rejects.not.toHaveProperty('refusal')
  pending.reject(timeout)
  state.session.run = undefined
  state.session.transport = undefined
  const caller = new AbortController()
  caller.abort(new Error('caller cancelled'))
  await expect(copy(undefined, true, 'selected', { signal: caller.signal })).rejects.toBe(
    caller.signal.reason
  )
})
