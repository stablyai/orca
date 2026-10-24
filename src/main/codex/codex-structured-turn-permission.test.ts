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
      approvalPolicy: 'untrusted',
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
