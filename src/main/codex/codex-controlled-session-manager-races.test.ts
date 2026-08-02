import { describe, expect, it, vi } from 'vitest'
import type { ConversationWakeTurnRequest } from '../runtime/orchestration/conversation-wake-provider'
import {
  CodexControlledSessionManager,
  type CodexControlledSessionIdentity,
  type CodexControlledSessionLaunch
} from './codex-controlled-session-manager'
import type { ControlledCodexSession } from './codex-controlled-session-registry'
import type { CodexControlledSessionStateStore } from './codex-controlled-session-state'
import { CodexControlledTurnFinalizer } from './codex-controlled-turn-finalizer'
import type { CodexUnixAppServerClient } from './codex-unix-app-server-client'

type Deferred = { promise: Promise<void>; resolve: () => void }

describe('CodexControlledSessionManager race fences', () => {
  it('revalidates session identity after terminal refresh', async () => {
    const fixture = createFixture()
    const refresh = fixture.blockRefresh()
    const state = fixture.manager.getState(target())
    await vi.waitFor(() => expect(fixture.refreshCalls).toHaveBeenCalledOnce())

    const replacement = fixture.replaceSession()
    refresh.resolve()

    await expect(state).resolves.toBe('unknown')
    expect(fixture.request).not.toHaveBeenCalled()
    expect(replacement.terminal.terminalHandle).toBe('replacement-handle')
  })

  it('discards a thread read from a replaced same-identity session', async () => {
    const fixture = createFixture()
    const read = fixture.blockRead()
    const state = fixture.manager.getState(target())
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())

    const replacement = fixture.replaceSession()
    read.resolve()

    await expect(state).resolves.toBe('unknown')
    expect(replacement.terminal.terminalHandle).toBe('replacement-handle')
  })

  it('detects an account change away and back after restoring the original selection reference', async () => {
    const fixture = createFixture()
    const read = fixture.blockRead()
    const state = fixture.manager.getState(target())
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    const originalSelection = fixture.accountSelection.value
    fixture.account.value = 'account-b'
    fixture.accountSelection.value = {}
    fixture.accountRevision.value += 1
    fixture.account.value = 'account-a'
    fixture.accountSelection.value = originalSelection
    fixture.accountRevision.value += 1
    read.resolve()

    await expect(state).resolves.toBe('unknown')
    await expect(fixture.manager.getState(target())).resolves.toBe('idle')
  })

  it('does not mark a session missing after account drift during reconciliation', async () => {
    const fixture = createFixture()
    const read = fixture.blockRead()
    fixture.read.error = Object.assign(new Error('localized response'), { rpcCode: -32600 })
    const reconciliation = fixture.manager.reconcile()
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    fixture.account.value = 'account-b'
    read.resolve()
    await reconciliation

    fixture.account.value = 'account-a'
    fixture.read.error = null
    await expect(fixture.manager.getState(target())).resolves.toBe('idle')
  })

  it('rejects a thread/read response for a different thread', async () => {
    const fixture = createFixture()
    fixture.read.threadId = 'thread-other'

    await expect(fixture.manager.getState(target())).resolves.toBe('unknown')
  })

  it('emits terminal only for a completed turn from the current session', () => {
    const fixture = createFixture()
    const listener = vi.fn()
    fixture.manager.onTurnTerminal(listener)

    for (const type of ['active', 'notLoaded', 'idle', 'systemError']) {
      fixture.notify(fixture.session, 'thread/status/changed', {
        threadId: 'thread-1',
        status: { type }
      })
    }
    const replaced = fixture.replaceSession()
    fixture.notify(fixture.session, 'turn/completed', { threadId: 'thread-1' })
    fixture.notify(replaced, 'turn/completed', { threadId: 'thread-1' })

    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('CodexControlledTurnFinalizer reconciliation responses', () => {
  it.each([
    ['missing turns', undefined],
    ['non-array turns', {}],
    ['a null turn', [null]],
    ['a turn missing its id', [{ items: [] }]],
    ['a turn with a non-string id', [{ id: 42, items: [] }]],
    ['a turn with an empty id', [{ id: '', items: [] }]],
    ['a turn missing its items', [{ id: 'turn-1' }]],
    ['a turn with non-array items', [{ id: 'turn-1', items: {} }]],
    ['a null item', [{ id: 'turn-1', items: [null] }]],
    ['an item missing its type', [{ id: 'turn-1', items: [{}] }]],
    ['an item with a non-string type', [{ id: 'turn-1', items: [{ type: 42 }] }]],
    ['an item with an empty type', [{ id: 'turn-1', items: [{ type: '' }] }]],
    [
      'a user item with a non-string client id',
      [{ id: 'turn-1', items: [{ type: 'userMessage', clientId: 42 }] }]
    ]
  ])('does not start an accepted turn when thread/read returns %s', async (_label, turns) => {
    const request = vi.fn(async (method: string) => ({
      thread: { id: 'thread-1', ...(turns === undefined ? {} : { turns }) },
      method
    }))
    const record = {
      operationId: 'operation-1',
      clientMessageId: 'operation-1',
      prompt: 'Check the mailbox.',
      phase: 'accepted' as const,
      codexTurnId: null
    }
    const state = {
      get: vi.fn(() => record),
      put: vi.fn()
    }
    const finalizer = new CodexControlledTurnFinalizer(
      {
        threadId: 'thread-1',
        client: { request } as unknown as CodexUnixAppServerClient,
        state: state as unknown as CodexControlledSessionStateStore
      },
      () => true
    )

    await expect(finalizer.prepareAndFinalize(acceptedTurnRequest())).rejects.toThrow(
      'turn reconciliation thread/read returned an invalid response'
    )
    expect(request).not.toHaveBeenCalledWith('turn/start', expect.anything())
    expect(state.put).not.toHaveBeenCalled()
  })
})

function createFixture() {
  const account = { value: 'account-a' as string | null }
  const accountSelection = { value: {} as object }
  const accountRevision = { value: 0 }
  const read = {
    blocker: null as Deferred | null,
    error: null as Error | null,
    threadId: 'thread-1'
  }
  let refreshBlocker: Deferred | null = null
  const refreshCalls = vi.fn(async (terminal: CodexControlledSessionIdentity) => {
    const blocker = refreshBlocker
    refreshBlocker = null
    await blocker?.promise
    return { ...terminal, terminalHandle: 'refreshed-handle' }
  })
  const request = vi.fn(async () => {
    const blocker = read.blocker
    read.blocker = null
    await blocker?.promise
    if (read.error) {
      throw read.error
    }
    return {
      thread: {
        id: read.threadId,
        status: { type: 'idle' },
        canAcceptDirectInput: true
      }
    }
  })
  const manager = new CodexControlledSessionManager({
    stateRoot: '/unused',
    createVisibleTerminal: async () => ({ handle: 'unused' }),
    waitForVisibleTerminal: refreshCalls,
    closeVisibleTerminal: async () => undefined,
    resolveCurrentAccountId: () => account.value,
    resolveCurrentAccountRevision: () => accountRevision.value,
    isControlledLaunchEnabled: () => true,
    isProviderEnabled: () => true,
    isWakeEnabled: () => true,
    isKillSwitchOpen: () => true
  })
  const session = createSession(request)
  getSessionMap(manager).set('conversation-1', session)
  return {
    account,
    accountRevision,
    accountSelection,
    manager,
    read,
    refreshCalls,
    request,
    session,
    blockRead: () => (read.blocker = createDeferred()),
    blockRefresh: () => (refreshBlocker = createDeferred()),
    replaceSession: () => {
      const replacement = {
        ...session,
        launch: { ...session.launch },
        terminal: { ...session.terminal, terminalHandle: 'replacement-handle' }
      }
      getSessionMap(manager).set('conversation-1', replacement)
      return replacement
    },
    notify: (source: ControlledCodexSession, method: string, params: Record<string, unknown>) =>
      notify(manager, source, method, params)
  }
}

function createSession(request: ReturnType<typeof vi.fn>): ControlledCodexSession {
  const launch: CodexControlledSessionLaunch = {
    conversationId: 'conversation-1',
    threadId: 'thread-1',
    worktreeSelector: 'id:worktree-1',
    workspaceKind: 'worktree',
    hostKind: 'local',
    cwd: '/workspace',
    codexHome: '/codex-home',
    accountId: 'account-a',
    presentation: 'focused'
  }
  return {
    launch,
    terminal: {
      conversationId: launch.conversationId,
      threadId: launch.threadId,
      terminalHandle: 'original-handle',
      terminalPtyId: 'pty-1',
      terminalTabId: 'tab-1',
      terminalPaneKey: 'pane-1',
      worktreeId: 'worktree-1'
    },
    client: { request } as unknown as ControlledCodexSession['client'],
    missing: false
  } as ControlledCodexSession
}

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

function getSessionMap(
  manager: CodexControlledSessionManager
): Map<string, ControlledCodexSession> {
  return (manager as unknown as { registry: { sessions: Map<string, ControlledCodexSession> } })
    .registry.sessions
}

function notify(
  manager: CodexControlledSessionManager,
  session: ControlledCodexSession,
  method: string,
  params: Record<string, unknown>
): void {
  ;(
    manager as unknown as {
      observeNotification(
        source: ControlledCodexSession,
        name: string,
        value: Record<string, unknown>
      ): void
    }
  ).observeNotification(session, method, params)
}

function target() {
  return { runId: 'run-1', consumerGeneration: 1, conversationId: 'conversation-1' }
}

function acceptedTurnRequest(): ConversationWakeTurnRequest {
  return {
    ...target(),
    wakeId: 'wake-1',
    idempotencyKey: 'wake-key-1',
    messageId: 'message-1',
    messageType: 'worker_done',
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    prompt: 'Check the mailbox.',
    acceptedTurnId: 'operation-1',
    commitPrepared: () => false
  }
}
