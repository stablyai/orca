import { expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from '../../runtime/generated-agent-input-notices'
import { channelHandlerLookup } from './runtime-environments-ipc-test-harness'

const h = vi.hoisted(() => ({
  handle: vi.fn(),
  call: vi.fn(),
  subscribe: vi.fn(),
  accounts: Promise.resolve()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => [] },
  ipcMain: { handle: h.handle, on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }
}))
vi.mock(
  '../../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveEnvironment: () => ({
      id: 'env',
      pairingRevision: 1,
      createdAt: 1,
      runtimeId: 'host-runtime'
    })
  })
)
// Account preparation a test holds open: the text must already be held while it waits.
vi.mock('../../wsl/orcad/wsl-orcad-account-env', () => ({
  withWslOrcadAccountEnv: async (args: { params: unknown }) => {
    await h.accounts
    return { ok: true, params: args.params }
  }
}))
vi.mock('./runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/tmp/profile'
}))
vi.mock('../../wsl/orcad/wsl-orcad-host-environments', () => ({
  observeWslOrcadHostResponse: vi.fn(),
  wslOrcadHostSupports: vi.fn()
}))
vi.mock('../../runtime/desktop-chat-creation-history', () => ({
  desktopChatCreationHistory: () => ({ recordCreate: async () => {} })
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: unknown[]) => h.call(...args),
  subscribeRuntimeEnvironment: (...args: unknown[]) => h.subscribe(...args)
}))

const { registerRuntimeHandlers } = await import('../runtime')
const { remoteRuntimeRequestDispatchObserver } =
  await import('../../../shared/remote-runtime/requests/remote-runtime-request-dispatch-observation')
const { markRuntimeEnvironmentManuallyDisconnected, clearRuntimeEnvironmentManualDisconnect } =
  await import('./runtime-environment-manual-disconnect')
const { registerRuntimeEnvironmentPassiveHandlers } =
  await import('./runtime-environment-connectivity-handlers')
const { registerRuntimeEnvironmentSubscriptionHandlers } =
  await import('./runtime-environment-subscription-handlers')

const SEND = 'terminal.sendGeneratedInput'
const send = (operationId: string) => ({
  selector: 'env',
  method: SEND,
  params: {
    // Only the verified runtime may run it; nothing else names that runtime to main.
    terminal: { handle: 'host-terminal', expectedRuntimeId: 'host-runtime' },
    text: 'exact\r\ntext 😀',
    submit: true,
    agent: 'claude',
    retainNotice: true,
    operationId,
    window: 'window-a'
  }
})

function windowEvent() {
  const mainFrame = {}
  const sender = {
    id: 7,
    mainFrame,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    isDestroyed: () => false
  }
  return { sender, senderFrame: mainFrame }
}

function setUp() {
  h.handle.mockReset()
  h.call.mockReset()
  h.subscribe.mockReset()
  const notices = new GeneratedAgentInputNotices()
  const remote = registerRuntimeHandlers({
    generatedInputNotices: notices,
    cleanupSubscriptionsForConnection: vi.fn(),
    getRuntimeId: () => 'local-runtime'
  } as never)
  registerRuntimeEnvironmentPassiveHandlers(() => '/tmp/profile', undefined, remote)
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => '/tmp/profile',
    remoteRuntimeSubscriptions: new Map(),
    pendingSubscriptions: new Map(),
    recordLayoutFrame: vi.fn(),
    acceptGeneratedInput: remote
  })
  const handler = channelHandlerLookup(h.handle)
  return { notices, handler, certainty: (id: string) => notices.noticeOf(id)?.certainty }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

// L1/L2/A2 at the remote unary seam: the window's exact text and its host receipt are held before
// account preparation is awaited, read as not sent until the transport sends it, and as possibly
// sent once a sent request's answer is lost. A replaced document's request still goes, unheld.
it('holds a remote request before its preparation and marks it sent only at dispatch', async () => {
  const { notices, handler, certainty } = setUp()
  const preparation = deferred<void>()
  h.accounts = preparation.promise
  const lost = deferred<never>()
  // The transport's own frame handoff, as every real send route reports it.
  h.call.mockImplementation(async (...args: unknown[]) => {
    remoteRuntimeRequestDispatchObserver(args[3])?.()
    return await lost.promise
  })
  const event = windowEvent()
  const answer = Promise.resolve(
    handler('runtimeEnvironments:call')(event, send('op-unary'))
  ).catch(() => null)
  expect(notices.noticeOf('op-unary')?.text).toBe('exact\r\ntext 😀')
  expect(certainty('op-unary')).toBe('not-sent')
  expect(h.call).not.toHaveBeenCalled()

  preparation.resolve()
  await vi.waitFor(() => expect(certainty('op-unary')).toBe('unconfirmed'))
  // Fenced at the receiver, not by main's registry runtime: no runtime expectation is passed on.
  expect(h.call.mock.calls[0][7]).toEqual({ expectedEnvironmentRuntimeId: undefined })
  lost.reject(new Error('socket closed'))
  await answer
  expect(notices.isPending('op-unary')).toBe(true)
  expect(certainty('op-unary')).toBe('unconfirmed')

  h.call.mockResolvedValue({ id: SEND, ok: true, result: {}, _meta: { runtimeId: 'host-runtime' } })
  await handler('runtimeEnvironments:call')(
    { sender: event.sender, senderFrame: {} },
    send('op-replaced-document')
  )
  expect(notices.noticeOf('op-replaced-document')).toBeUndefined()
  expect(h.call).toHaveBeenCalledTimes(2)
})

// The cancellable route: held before its connection preparation; the host's answer, arriving
// after the window went away, settles a delivered request with no renderer left.
it('holds a cancellable remote request and settles it from the host answer alone', async () => {
  const { notices, handler, certainty } = setUp()
  h.accounts = Promise.resolve()
  const connecting = deferred<void>()
  let respond: (response: unknown) => void = () => {}
  h.subscribe.mockImplementation(async (...args: unknown[]) => {
    await connecting.promise
    const callbacks = args[5] as { onEvent: (payload: unknown) => void }
    remoteRuntimeRequestDispatchObserver(args[3])?.()
    respond = (response) => callbacks.onEvent({ type: 'response', response })
    return { requestId: 'request', close: vi.fn(), sendBinary: vi.fn() }
  })
  const subscribed = handler('runtimeEnvironments:subscribe')(windowEvent(), {
    ...send('op-cancellable'),
    subscriptionId: 'cancellable'
  })
  expect(certainty('op-cancellable')).toBe('not-sent')
  connecting.resolve()
  await subscribed
  expect(certainty('op-cancellable')).toBe('unconfirmed')
  respond({
    id: SEND,
    ok: true,
    result: { delivery: { outcome: 'delivered' } },
    _meta: { runtimeId: 'host-runtime' }
  })
  expect(notices.noticeOf('op-cancellable')).toBeUndefined()
})

// CR6b: a request main refuses before sending (here, a manual disconnect) is held first and proven
// not sent, and a later generic "may have been sent" from the window cannot undo that proof.
it('proves a request refused before sending unsent, over the window’s later inference', async () => {
  const { notices, handler, certainty } = setUp()
  markRuntimeEnvironmentManuallyDisconnected('env')
  try {
    await handler('runtimeEnvironments:call')(windowEvent(), send('op-disconnected'))
  } finally {
    clearRuntimeEnvironmentManualDisconnect('env')
  }
  expect(h.call).not.toHaveBeenCalled()
  notices.upsert({
    id: 'op-disconnected',
    origin: 'desktop-window:7',
    text: 'exact\r\ntext 😀',
    agent: 'claude',
    certainty: 'unconfirmed',
    handle: '',
    worktreeId: '',
    ptyId: null,
    reported: true
  })
  expect(certainty('op-disconnected')).toBe('not-sent')
})

// XR2 legacy remote route: each terminal.send frame of an accepted request settles it where it
// leaves main; only a refusal before any frame may have been taken proves it unsent, and the
// request id never reaches the older host's wire.
it('settles an older host’s writes by their frames and answers', async () => {
  const { notices, handler, certainty } = setUp()
  notices.upsert({
    id: 'op-legacy',
    origin: 'desktop-window:7',
    pending: true,
    text: 'exact',
    agent: 'claude',
    certainty: 'not-sent',
    handle: '',
    worktreeId: '',
    ptyId: 'remote-pty'
  })
  const write = async (accepted: boolean) => {
    h.call.mockImplementationOnce(async (...args: unknown[]) => {
      remoteRuntimeRequestDispatchObserver(args[3])?.()
      return {
        id: 'terminal.send',
        ok: true,
        result: { send: { accepted } },
        _meta: { runtimeId: 'h' }
      }
    })
    await handler('runtimeEnvironments:call')(windowEvent(), {
      selector: 'env',
      method: 'terminal.send',
      params: { terminal: 'host-terminal', text: 'exact' },
      generatedInputOperationId: 'op-legacy'
    })
  }
  await write(false)
  expect(certainty('op-legacy')).toBe('not-sent')
  expect(h.call.mock.calls[0][3]).toEqual({ terminal: 'host-terminal', text: 'exact' })
  await write(true)
  await write(false)
  expect(certainty('op-legacy')).toBe('unconfirmed')
})

// XR7 cancellable route to an older generated host: the request keeps no notice by id on the
// wire, but its local id reaches main through the subscription call, which follows its frame.
it('follows a cancellable request to an older generated host by its local id', async () => {
  const { notices, handler, certainty } = setUp()
  h.accounts = Promise.resolve()
  notices.upsert({
    id: 'op-old-signal',
    origin: 'desktop-window:7',
    pending: true,
    text: 'exact',
    agent: 'claude',
    certainty: 'not-sent',
    handle: '',
    worktreeId: '',
    ptyId: null
  })
  let respond: (response: unknown) => void = () => {}
  h.subscribe.mockImplementation(async (...args: unknown[]) => {
    const callbacks = args[5] as { onEvent: (payload: unknown) => void }
    remoteRuntimeRequestDispatchObserver(args[3])?.()
    respond = (response) => callbacks.onEvent({ type: 'response', response })
    return { requestId: 'request', close: vi.fn(), sendBinary: vi.fn() }
  })
  const plain = { terminal: 'host-terminal', text: 'exact', submit: true, agent: 'claude' }
  await handler('runtimeEnvironments:subscribe')(windowEvent(), {
    selector: 'env',
    method: SEND,
    params: plain,
    subscriptionId: 'old-signal',
    generatedInputOperationId: 'op-old-signal'
  })
  expect(h.subscribe.mock.calls[0][3]).toEqual(plain)
  expect(certainty('op-old-signal')).toBe('unconfirmed')
  respond({
    id: SEND,
    ok: true,
    result: { delivery: { outcome: 'not-sent' } },
    _meta: { runtimeId: 'host-runtime' }
  })
  expect(certainty('op-old-signal')).toBe('not-sent')
})

// CNG2/CNG3 in main: a generated request's own end bounds its preparation here. One whose end
// passes while main still prepares it is never handed to the transport (proven unsent); one whose
// frame left keeps its factual answer, which that end no longer cuts.
it('spends a generated request’s own end on main preparation, never on its answer', async () => {
  const { notices, handler, certainty } = setUp()
  const preparation = deferred<void>()
  h.accounts = preparation.promise
  const call = (operationId: string, generatedInputEnd: number) =>
    Promise.resolve(
      handler('runtimeEnvironments:call')(windowEvent(), {
        ...send(operationId),
        generatedInputEnd
      })
    )
  // ast-grep-ignore: test-no-wall-clock -- main's dispatch end is a real timer; the expiry is the behavior under test
  const expired = call('op-expired', Date.now() + 20)
  // ast-grep-ignore: test-no-real-time-wait -- waits past main's real dispatch timer, the behavior under test
  await new Promise((resolve) => setTimeout(resolve, 40))
  preparation.resolve()
  await expect(expired).resolves.toMatchObject({ ok: false, error: { code: 'runtime_timeout' } })
  expect(h.call).not.toHaveBeenCalled()
  expect(certainty('op-expired')).toBe('not-sent')

  h.accounts = Promise.resolve()
  h.call.mockImplementation(async (...args: unknown[]) => {
    // The frame leaves, then the host answers only after the end.
    remoteRuntimeRequestDispatchObserver(args[3])?.()
    // ast-grep-ignore: test-no-real-time-wait -- waits past main's real dispatch timer, the behavior under test
    await new Promise((resolve) => setTimeout(resolve, 40))
    return {
      id: SEND,
      ok: true,
      result: { delivery: { outcome: 'delivered' } },
      _meta: { runtimeId: 'host-runtime' }
    }
  })
  // ast-grep-ignore: test-no-wall-clock -- main's dispatch end is a real timer; the expiry is the behavior under test
  await expect(call('op-answered', Date.now() + 20)).resolves.toMatchObject({ ok: true })
  const { signal } = h.call.mock.calls[0][7] as { signal: AbortSignal }
  expect(signal.aborted).toBe(false)
  expect(notices.noticeOf('op-answered')).toBeUndefined()
})
