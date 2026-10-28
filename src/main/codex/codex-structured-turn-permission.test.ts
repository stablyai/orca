import {
  adapterFor,
  acquireReadyCodexForTest,
  identityFor,
  answerWithOpenedTurn,
  fakeCodex,
  USER_MESSAGE,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'
import { CodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { expect, it, vi } from 'vitest'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import {
  acquiredCodexAdapter,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  fakeCodexAppServer,
  startTurn
} from './codex-structured-dispatch-test-support'

const workspace = {
  writable_roots: ['/extra'],
  network_access: true,
  exclude_tmpdir_env_var: true,
  exclude_slash_tmp: true
}
const sandbox = {
  type: 'workspaceWrite',
  writableRoots: ['/extra'],
  networkAccess: true,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true
}

it('rereads the host choice after preparation and keeps the exact configured Auto policy', async () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  let nextTurn = 0
  const configuration = Promise.withResolvers<unknown>()
  const codex = fakeCodexAppServer({
    'config/read': () => configuration.promise,
    'configRequirements/read': () => ({ requirements: null }),
    'turn/start': () => ({ turn: { id: `fresh-${++nextTurn}` } })
  })
  const adapter = await acquiredCodexAdapter({
    codex,
    settlements: [],
    permissionMode: 'full-access'
  })
  const connection = codex.connections[0]!
  let mode: AgentChatPermissionMode = 'auto'
  const send = (id: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      fence: 7,
      body: CODEX_TEST_USER_MESSAGE,
      admitFreshInput: async (enqueue) => enqueue(mode, false),
      isCurrent: () => true
    })
  const end = () => {
    startTurn(connection, `fresh-${nextTurn}`)
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: `fresh-${nextTurn}`, status: 'completed' }
    })
  }
  try {
    const sending = send('latest-choice')
    await vi.waitFor(() =>
      expect(connection.calls.some((c) => c.method === 'configRequirements/read')).toBe(true)
    )
    mode = 'ask'
    configuration.resolve({ config: { sandbox_workspace_write: workspace } })
    expect(await sending).toMatchObject({ state: 'admitted' })
    expect(connection.calls.at(-1)?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly' }
    })
    end()
    mode = 'auto'
    expect(await send('configured-auto')).toMatchObject({ state: 'admitted' })
    expect(connection.calls.at(-1)?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: sandbox
    })
    end()
    codex.routes['config/read'] = () => ({
      config: {
        sandbox_workspace_write: {
          ...workspace,
          writable_roots: ['/new'],
          network_access: false,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: false
        }
      }
    })
    expect(await send('updated-config')).toMatchObject({ state: 'admitted' })
    expect(connection.calls.at(-1)?.params?.sandboxPolicy).toEqual({
      ...sandbox,
      writableRoots: ['/new'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    })
    end()
  } finally {
    await adapter.closeAll()
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
})

it.each([null])('omits own policy on fresh input after opening %s', async (resumeThreadId) => {
  const codex = fakeCodex()
  const configured = () => ({
    thread: { id: THREAD_ID },
    model: 'gpt-live',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: ['/configured'] }
  })
  codex.routes['thread/start'] = codex.routes['thread/resume'] = configured
  const adapter = adapterFor(codex, { resumeThreadId })
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'own-child',
    permissionMode: 'own'
  })
  const connection = codex.connections[0]!
  let mode: 'own' | 'full-access' = 'own'
  const send = (id: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      fence: 7,
      body: USER_MESSAGE,
      admitFreshInput: async (enqueue) => enqueue(mode, false)
    })
  try {
    expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current).toMatchObject(
      { reportedPermissionMode: 'ask' }
    )
    for (const [index, choice] of ['own', 'full-access', 'own'].entries()) {
      mode = choice === 'own' ? 'own' : 'full-access'
      codex.routes['turn/start'] = answerWithOpenedTurn(codex, `own-${index}`)
      expect(await send(`original-${index}`)).toMatchObject({ state: 'admitted' })
      const params = connection.calls.findLast((call) => call.method === 'turn/start')!.params!
      if (mode === 'own') {
        expect(params).not.toHaveProperty('approvalPolicy')
        expect(params).not.toHaveProperty('approvalsReviewer')
        expect(params).not.toHaveProperty('sandboxPolicy')
      } else {
        expect(params).toMatchObject({
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'dangerFullAccess' }
        })
      }
      expect(params.clientUserMessageId).toBe(`original-${index}`)
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
      ).toMatchObject({ reportedPermissionMode: index === 0 ? 'ask' : 'full-access' })
      connection.handlers.onNotification?.('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: `own-${index}`, status: 'completed' }
      })
    }
    const opened = connection.calls.find((call) => call.method.startsWith('thread/'))!.params!
    expect(opened).not.toHaveProperty('approvalPolicy')
    expect(opened).not.toHaveProperty('approvalsReviewer')
    expect(opened).not.toHaveProperty('sandbox')
    expect(connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(3)
    expect(codex.connections).toHaveLength(1)
  } finally {
    await adapter.closeAll()
  }
})

it.each(['accepted', 'refused', 'transport'] as const)(
  'updates applied evidence only for exact successful fresh input: %s',
  async (outcome) => {
    const answer = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'turn/start': () => answer.promise })
    codex.routes['thread/start'] = () => ({
      thread: { id: THREAD_ID },
      model: 'gpt-live',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: { type: 'workspaceWrite' }
    })
    const adapter = adapterFor(codex)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'applied-child',
      permissionMode: 'auto'
    })
    let requested: AgentChatPermissionMode = 'ask'
    const sending = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'exact-applied',
      fence: 7,
      body: USER_MESSAGE,
      admitFreshInput: async (enqueue) => enqueue(requested, false)
    })
    const finished = sending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    const connection = codex.connections[0]!
    try {
      await vi.waitFor(() =>
        expect(connection.calls.some((call) => call.method === 'turn/start')).toBe(true)
      )
      expect(connection.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly' }
      })
      startTurn(connection, 'applied-turn')
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
      ).toMatchObject({ reportedPermissionMode: 'auto' })
      requested = 'full-access'
      if (outcome === 'accepted') {
        answer.resolve({ turn: { id: 'applied-turn' } })
      } else {
        answer.reject(
          outcome === 'refused'
            ? new CodexAppServerRequestError('turn/start', -32600, 'input refused')
            : new Error('transport ended after writing')
        )
      }
      const result = await finished
      if (outcome === 'accepted') {
        expect(result).toMatchObject({ value: { state: 'admitted' } })
      } else if (outcome === 'refused') {
        expect(result).toMatchObject({ value: { state: 'rejected' } })
      } else {
        expect(result).toHaveProperty('error')
      }
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
      ).toMatchObject({ reportedPermissionMode: outcome === 'accepted' ? 'ask' : 'auto' })
      expect(connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
      expect(codex.connections).toHaveLength(1)
    } finally {
      answer.resolve({ turn: { id: 'applied-turn' } })
      await finished
      await adapter.closeAll()
    }
  }
)
