import type * as AppServerSession from './app-server/codex-app-server-session'
import type * as LocalHistory from '../native-chat/codex-local-history'
import type * as RolloutStream from '../native-chat/codex-rollout-history-stream'
import { readCodexLocalHistory } from '../native-chat/codex-local-history'
import { readCodexRolloutBytes } from '../native-chat/codex-rollout-history-stream'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { copyCodexConversation } from './codex-conversation-copy'
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
