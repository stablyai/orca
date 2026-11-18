import type * as AppServerSession from './app-server/codex-app-server-session'
import type * as LocalHistory from '../native-chat/transcript-history/codex/codex-local-history'
import type * as RolloutStream from '../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { readCodexLocalHistory } from '../native-chat/transcript-history/codex/codex-local-history'
import { readCodexRolloutBytes } from '../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionRecordFixture } from '../native-chat/testing/agent-session-record-test-fixture'
import { copyCodexConversation } from './codex-conversation-copy'
import { CodexAppServerTimeoutError } from './app-server/codex-app-server-session'
import type { CodexAppServerRpc } from './app-server/codex-app-server-session'

const state = vi.hoisted(() => {
  const session: {
    run?: (body: (rpc: CodexAppServerRpc) => Promise<unknown>) => Promise<unknown>
    transport?:
      | 'native'
      | 'unsupported-read'
      | 'unsupported-fork'
      | 'unsupported-goal'
      | 'disabled-goal'
  } = {}
  return {
    home: '',
    paths: new Map<string, string>(),
    request: vi.fn<CodexAppServerRpc['request']>(),
    initialize: vi.fn(),
    session
  }
})
vi.mock('../native-chat/transcript-history/codex/codex-local-history', async (importOriginal) => {
  const original = await importOriginal<typeof LocalHistory>()
  return { ...original, readCodexLocalHistory: vi.fn(original.readCodexLocalHistory) }
})
vi.mock(
  '../native-chat/transcript-history/codex/codex-rollout-history-stream',
  async (importOriginal) => {
    const original = await importOriginal<typeof RolloutStream>()
    return { ...original, readCodexRolloutBytes: vi.fn(original.readCodexRolloutBytes) }
  }
)
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
            const error = message.method === 'thread/fork' && process.argv[1] === 'unsupported-fork'
              ? { code: -32601, message: 'thread/fork is not supported yet' }
              : message.method === 'thread/goal/clear' && process.argv[1] === 'unsupported-goal'
                ? { code: -32601, message: 'thread/goal/clear is not supported yet' }
                : message.method === 'thread/goal/clear' && process.argv[1] === 'disabled-goal'
                  ? { code: -32600, message: 'goals feature is disabled' }
                  : message.method === 'thread/read' && process.argv[1] === 'unsupported-read'
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
function copy(
  selected = `${SOURCE}:a1`,
  settled = true,
  turnId?: string,
  options: {
    signal?: AbortSignal
    selectedItemId?: string
    model?: string
    current?: true
    copiedSessionId?: string
    onCopyConfirmed?: (sessionId: string) => Promise<void>
  } = {}
) {
  return copyCodexConversation(
    {
      record: agentSessionRecordFixture({
        sessionId: 'orca-source',
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: root },
        launchArgs: ['--model', 'saved-model'],
        ...(options.model === undefined ? {} : { options: { model: options.model } })
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
      copiedSessionId: options.copiedSessionId,
      onCopyConfirmed: options.onCopyConfirmed,
      title: 'Source fork',
      accountHome: { variable: 'CODEX_HOME', path: root },
      ...(options.current ? { current: true as const } : {}),
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

it.each([
  { selected: 'gpt-terra', read: 'gpt-astra', expected: 'gpt-terra', provider: 'thread-provider' },
  { selected: '', read: 'gpt-terra', expected: 'gpt-terra', provider: 'thread-provider' },
  { selected: undefined, read: 'gpt-terra', expected: 'gpt-terra', provider: 'thread-provider' },
  { selected: undefined, read: undefined, expected: undefined, provider: undefined }
])(
  "forks on the chat's model (selected $selected, thread $read)",
  async ({ selected, read, expected, provider }) => {
    state.request.mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: SOURCE,
            historyMode: 'paginated',
            model: read,
            modelProvider: 'thread-provider'
          }
        }
      }
      if (method === 'thread/fork') {
        return { thread: { id: CHILD } }
      }
      return { data: [{ id: 'selected', status: 'completed' }], nextCursor: null }
    })
    await expect(copy(undefined, true, 'selected', { model: selected })).resolves.toMatchObject({
      sessionId: CHILD
    })
    const fork = state.request.mock.calls.find(([method]) => method === 'thread/fork')?.[1]
    expect(fork).toMatchObject({ threadId: SOURCE })
    expect(fork?.model).toBe(expected)
    expect(fork?.modelProvider).toBe(provider)
  }
)

it.each(['native', 'unsupported-goal', 'disabled-goal'] as const)(
  'copies the current running conversation through the %s transport',
  async (transport) => {
    state.session.transport = transport
    state.paths.set('current-child', join(root, 'sessions', 'current-child.jsonl'))
    state.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') {
        return { thread: { id: SOURCE, historyMode: 'paginated', model: 'active-model' } }
      }
      if (method === 'thread/fork') {
        expect(params).toEqual({
          threadId: SOURCE,
          excludeTurns: true,
          cwd: root,
          model: 'active-model'
        })
        return { thread: { id: 'current-child' } }
      }
      if (method === 'thread/goal/clear') {
        expect(params).toEqual({ threadId: 'current-child', origin: 'user' })
        return {}
      }
      throw new Error('A current-context fork must not choose a completed turn')
    })
    expect(await copy(undefined, false, 'running-turn', { current: true })).toEqual({
      sessionId: 'current-child',
      filePath: join(root, 'sessions', 'current-child.jsonl')
    })
    if (transport === 'native') {
      expect(state.request).toHaveBeenCalledWith('thread/goal/clear', {
        threadId: 'current-child',
        origin: 'user'
      })
    }
  }
)

it.each(['unsupported-read', 'unsupported-fork'] as const)(
  'definitively refuses a current copy when %s is missing from the real transport',
  async (transport) => {
    state.session.transport = transport
    state.request.mockResolvedValue({ thread: { id: SOURCE } })
    await expect(copy(undefined, false, undefined, { current: true })).rejects.toMatchObject({
      refusal: {
        code: 'structured_agent_session_unsupported',
        createAttemptRefusedBeforeCommit: true
      }
    })
  }
)

it.each(['missing-rollout', 'clear-failed', 'archive-unconfirmed'])(
  'keeps the confirmed child recoverable after %s',
  async (failure) => {
    state.request.mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return { thread: { id: SOURCE } }
      }
      if (method === 'thread/fork') {
        return { thread: { id: CHILD } }
      }
      if (method === 'thread/goal/clear' && failure !== 'missing-rollout') {
        throw new Error('clear failed')
      }
      if (method === 'thread/archive' && failure === 'archive-unconfirmed') {
        throw new Error('archive reply lost')
      }
      return {}
    })
    await expect(copy(undefined, false, undefined, { current: true })).rejects.toThrow(CHILD)
    expect(state.request).toHaveBeenCalledWith(
      'thread/archive',
      { threadId: CHILD },
      { timeoutMs: 5000 }
    )
    expect(state.request.mock.calls.filter(([method]) => method === 'thread/fork')).toEqual([
      ['thread/fork', { threadId: SOURCE, excludeTurns: true, cwd: root }]
    ])
  }
)

it('reopens a receipt-confirmed copy without reading or forking the source again', async () => {
  state.paths.set(CHILD, join(root, 'sessions', 'child.jsonl'))
  state.request.mockImplementation(async (method, params) => {
    if (method !== 'thread/goal/clear') {
      throw new Error('must not create another snapshot')
    }
    expect(params).toEqual({ threadId: CHILD, origin: 'user' })
    return {}
  })
  await expect(
    copy(undefined, false, undefined, { current: true, copiedSessionId: CHILD })
  ).resolves.toEqual({
    sessionId: CHILD,
    filePath: join(root, 'sessions', 'child.jsonl')
  })
  expect(state.request).toHaveBeenCalledWith('thread/goal/clear', {
    threadId: CHILD,
    origin: 'user'
  })
})

it('confirms the native child before optional copy preparation can fail', async () => {
  const confirmed: string[] = []
  state.request.mockImplementation(async (method) => {
    if (method === 'thread/read') {
      return { thread: { id: SOURCE } }
    }
    if (method === 'thread/fork') {
      return { thread: { id: CHILD } }
    }
    throw new Error('goal clear failed')
  })
  await expect(
    copy(undefined, false, undefined, {
      current: true,
      onCopyConfirmed: async (sessionId) => {
        confirmed.push(sessionId)
      }
    })
  ).rejects.toThrow('Retry will reopen this saved copy.')
  expect(confirmed).toEqual([CHILD])
})
