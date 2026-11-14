import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import * as environmentStore from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import * as setup from './runtime-environment-subscription-setup'
import { resetRuntimeEnvironmentStatusOwners } from '../connections/runtime-environment-request-connections'
import { advanceRuntimeEnvironmentTransportGeneration } from '../connections/runtime-environment-transport-generation'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  getPathMock,
  sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequestMock,
  sendRemoteRuntimeConnectionRequestMock,
  sendRemoteRuntimeSharedControlRequestMock,
  subscribeRemoteRuntimeSharedControlRequestMock,
  getRemoteRuntimeSharedControlDiagnosticsMock,
  reconnectRemoteRuntimeSharedControlConnectionMock,
  retryRemoteRuntimeSharedControlConnectionsNowMock,
  closeRemoteRuntimeRequestConnectionMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  getPathMock: vi.fn(),
  sendRemoteRuntimeRequestMock: vi.fn(),
  subscribeRemoteRuntimeRequestMock: vi.fn(),
  sendRemoteRuntimeConnectionRequestMock: vi.fn(),
  sendRemoteRuntimeSharedControlRequestMock: vi.fn(),
  subscribeRemoteRuntimeSharedControlRequestMock: vi.fn(),
  getRemoteRuntimeSharedControlDiagnosticsMock: vi.fn(),
  reconnectRemoteRuntimeSharedControlConnectionMock: vi.fn(),
  retryRemoteRuntimeSharedControlConnectionsNowMock: vi.fn(),
  closeRemoteRuntimeRequestConnectionMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: sendRemoteRuntimeRequestMock
}))
vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport', () => ({
  subscribeRemoteRuntimeTransport: subscribeRemoteRuntimeRequestMock
}))

vi.mock('../connections/runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('../runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: sendRemoteRuntimeConnectionRequestMock,
    sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
    subscribeRemoteRuntimeSharedControlRequest: subscribeRemoteRuntimeSharedControlRequestMock,
    getRemoteRuntimeSharedControlDiagnostics: getRemoteRuntimeSharedControlDiagnosticsMock,
    reconnectRemoteRuntimeSharedControlConnection:
      reconnectRemoteRuntimeSharedControlConnectionMock,
    retryRemoteRuntimeSharedControlConnectionsNow:
      retryRemoteRuntimeSharedControlConnectionsNowMock,
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn(),
    closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
  })
})
import { registerRuntimeEnvironmentHandlers } from '../runtime-environments'
import { channelHandlerLookup, pairingCode } from '../runtime-environments-ipc-test-harness'

const handler = channelHandlerLookup(handleMock)

describe('registerRuntimeEnvironmentHandlers', () => {
  let userDataPath: string
  let activeRuntimeEnvironmentId: string | null
  let store: {
    getSettings: () => { activeRuntimeEnvironmentId: string | null }
    updateSettings: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
    activeRuntimeEnvironmentId = null
    store = {
      getSettings: () => ({ activeRuntimeEnvironmentId }),
      updateSettings: vi.fn((updates: { activeRuntimeEnvironmentId: string | null }) => {
        activeRuntimeEnvironmentId = updates.activeRuntimeEnvironmentId
      })
    }
    getPathMock.mockReset()
    getPathMock.mockReturnValue(userDataPath)
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    sendRemoteRuntimeRequestMock.mockReset()
    // A re-pair restarts status; left unanswered so it never settles mid-test.
    sendRemoteRuntimeRequestMock.mockReturnValue(new Promise(() => {}))
    subscribeRemoteRuntimeRequestMock.mockReset()
    sendRemoteRuntimeConnectionRequestMock.mockReset()
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
    subscribeRemoteRuntimeSharedControlRequestMock.mockReset()
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReset()
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue(null)
    reconnectRemoteRuntimeSharedControlConnectionMock.mockReset()
    retryRemoteRuntimeSharedControlConnectionsNowMock.mockReset()
    closeRemoteRuntimeRequestConnectionMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetRuntimeEnvironmentStatusOwners()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it.each(['initial', 'final'])(
    'an unsubscribe during %s preparation cannot retain or replace its successor',
    async (phase) => {
      await registerRuntimeEnvironmentHandlers(store as never)
      await environmentStore.addEnvironmentFromPairingCode(userDataPath, {
        name: 'desk',
        pairingCode: pairingCode()
      })
      const firstClose = vi.fn()
      const successorClose = vi.fn()
      subscribeRemoteRuntimeRequestMock.mockResolvedValueOnce({
        requestId: 'first',
        close: phase === 'final' ? firstClose : successorClose,
        sendBinary: vi.fn()
      })
      if (phase === 'final') {
        subscribeRemoteRuntimeRequestMock.mockResolvedValueOnce({
          requestId: 'successor',
          close: successorClose,
          sendBinary: vi.fn()
        })
      }
      const frame = { detached: false }
      const sender = {
        id: 1,
        mainFrame: frame,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn()
      }
      const event = { sender, senderFrame: frame }
      const subscribe = handler<
        { selector: string; method: string; subscriptionId: string },
        { subscriptionId: string; requestId: string }
      >('runtimeEnvironments:subscribe')
      const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
        'runtimeEnvironments:unsubscribe'
      )
      let release!: () => void
      let entered!: () => void
      const reached = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const resolveEnvironment = environmentStore.resolveEnvironment
      const delayed =
        phase === 'initial'
          ? vi
              .spyOn(environmentStore, 'resolveEnvironment')
              .mockImplementationOnce(async (...args) => {
                entered()
                await gate
                return resolveEnvironment(...args)
              })
          : vi.spyOn(setup, 'assertSubscriptionPairingCurrent').mockImplementationOnce(async () => {
              entered()
              await gate
            })
      const args = { selector: 'desk', method: 'terminal.subscribe', subscriptionId: 'owned' }
      const first = Promise.resolve(subscribe(event, args))
      // Attach before canceling: the first operation must fail without leaking a rejection.
      const firstSettled = first.catch(() => null)
      await reached
      expect(await unsubscribe(event, { subscriptionId: 'owned' })).toEqual({ unsubscribed: true })
      await subscribe(event, args)
      release()
      await firstSettled
      delayed.mockRestore()
      expect(successorClose).not.toHaveBeenCalled()
      expect(await unsubscribe(event, { subscriptionId: 'owned' })).toEqual({ unsubscribed: true })
      expect(successorClose).toHaveBeenCalled()
      if (phase === 'final') {
        expect(firstClose).toHaveBeenCalled()
      }
    }
  )
  it('holds timed signal-route admission after setup while foreground and status subscriptions remain runnable', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers use only the fixture settings methods.
    await registerRuntimeEnvironmentHandlers(store as never)
    const finish: (() => void)[] = []
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_connection, _method, _params, _timeout, callbacks) => {
        finish.push(() =>
          callbacks.onResponse({ id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'runtime' } })
        )
        return { requestId: `request-${finish.length}`, close: vi.fn(), sendBinary: vi.fn() }
      }
    )
    const add = handler<{ name: string; pairingCode: string }, unknown>(
      'runtimeEnvironments:addFromPairingCode'
    )
    await add(null, { name: 'desk', pairingCode: pairingCode() })
    const mainFrame = { detached: false }
    const sender = {
      id: 1,
      mainFrame,
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const subscribe = handler<
      {
        selector: string
        method: string
        params: { reason?: string; selected?: boolean }
        subscriptionId: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const start = (subscriptionId: string, reason: string, method = 'github.prForBranch') =>
      subscribe(
        { sender, senderFrame: mainFrame },
        { selector: 'desk', subscriptionId, method, params: { reason, selected: true } }
      )
    await start('timer-1', 'swr')
    expect(subscribeRemoteRuntimeRequestMock.mock.calls[0][2]).toMatchObject({
      reason: 'swr',
      selected: true
    })
    await start('timer-2', 'swr')
    const third = start('timer-3', 'swr')
    const cancelled = expect(third).rejects.toThrow()
    await start('manual', 'manual')
    await start('status', '', 'git.status')
    await start('review', '', 'hostedReview.forBranch')
    expect(finish).toHaveLength(5)
    const cancel = handler<{ subscriptionId: string }, unknown>('runtimeEnvironments:unsubscribe')
    await cancel({ sender }, { subscriptionId: 'timer-3' })
    await cancelled
    const fourth = start('timer-4', 'swr')
    finish[0]()
    await fourth
    expect(finish).toHaveLength(6)
    const unsubscribe = handler<{ subscriptionId: string }, unknown>(
      'runtimeEnvironments:unsubscribe'
    )
    for (const subscriptionId of ['timer-1', 'timer-2', 'timer-4', 'manual', 'status', 'review']) {
      await unsubscribe({ sender }, { subscriptionId })
    }
  })

  it('rejects cross-window streaming subscription control', async () => {
    await registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    const sendBinary = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'stream-1',
      close,
      sendBinary
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const mainFrame = { detached: false }
    const result = await subscribe(
      {
        senderFrame: mainFrame,
        sender: {
          mainFrame,
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          on: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'owned-sub'
      }
    )

    const binaryListener = onMock.mock.calls.find(
      (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
    )?.[1] as (_event: unknown, args: unknown) => void
    binaryListener(
      { sender: { id: 2 } },
      { subscriptionId: result.subscriptionId, bytes: new Uint8Array([1]) }
    )
    expect(sendBinary).not.toHaveBeenCalled()

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 2 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
    expect(close).not.toHaveBeenCalled()

    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: true
    })
    expect(close).toHaveBeenCalled()
  })

  // #39926: a rebuilt control connection advances the transport generation, after which every
  // frame of an existing stream was discarded without a close, so a chat view sat on a silent stream.
  it('closes and reports a stream whose transport generation was retired', async () => {
    await registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'stream-1',
      close,
      sendBinary: vi.fn()
    })
    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const { environment } = await add(null, { name: 'desk', pairingCode: pairingCode() })
    const send = vi.fn()
    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const mainFrame = { detached: false }
    await subscribe(
      {
        senderFrame: mainFrame,
        sender: {
          mainFrame,
          id: 1,
          isDestroyed: () => false,
          send,
          on: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: 'desk',
        method: 'agentSession.subscribe',
        params: { sessionId: 'chat-1' },
        subscriptionId: 'chat-sub'
      }
    )

    advanceRuntimeEnvironmentTransportGeneration(environment.id)

    expect(close).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
      subscriptionId: 'chat-sub',
      type: 'close'
    })
  })
})
