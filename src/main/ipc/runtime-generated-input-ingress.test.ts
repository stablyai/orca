import { expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from '../runtime/generated-agent-input-notices'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn()
  }
}))

const { registerRuntimeHandlers } = await import('./runtime')

const SEND = 'terminal.sendGeneratedInput'
const request = (operationId: string) => ({
  ptyId: 'pty-1',
  text: 'exact text',
  submit: true,
  agent: 'claude',
  retainNotice: true,
  operationId
})

function windowEvent() {
  const mainFrame = {}
  return {
    sender: {
      id: 7,
      mainFrame,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => true
    },
    senderFrame: mainFrame
  }
}

// L1/L2/A2: the window's generated request is held by its own runtime where it enters this
// process, before anything about the send is awaited, on the unary and the cancellable route, and
// only for the window's current document.
it('holds a window’s request at its IPC ingress, for its current document only', async () => {
  const notices = new GeneratedAgentInputNotices()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial runtime; the channels this test calls reach only the members stubbed here.
  const remote = registerRuntimeHandlers({
    generatedInputNotices: notices,
    cleanupSubscriptionsForConnection: vi.fn(),
    getRuntimeId: () => 'local-runtime'
  } as never)
  const handler = (channel: string) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ipcMain.handle's second argument is the channel's handler.
    handleMock.mock.calls.find(([name]) => name === channel)![1] as (
      event: unknown,
      args: unknown
    ) => unknown
  const event = windowEvent()

  const answer = Promise.resolve(
    handler('runtime:call')(event, { method: SEND, params: request('op-unary') })
  ).catch(() => {})
  expect(notices.isPending('op-unary')).toBe(true)
  handler('runtime:subscribe')(event, {
    subscriptionId: 'cancellable',
    method: SEND,
    params: request('op-cancellable')
  })
  expect(notices.isPending('op-cancellable')).toBe(true)

  const host = { id: 'env', pairingRevision: 1, createdAt: 1, runtimeId: 'registry-guess' }
  const call = (id: string) => ({
    method: SEND,
    params: request(id),
    expectedEnvironmentRuntimeId: 'host-runtime'
  })
  const replaced = { sender: event.sender, senderFrame: {} }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ingress reads only sender/senderFrame of the event and the stored environment record.
  expect(remote(replaced as never, host as never, call('op-stale-frame'))).toBeNull()
  expect(notices.isPending('op-stale-frame')).toBe(false)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ingress reads only sender/senderFrame of the event and the stored environment record.
  expect(remote(event as never, host as never, call('op-remote'))).not.toBeNull()
  expect(notices.isPending('op-remote')).toBe(true)
  // Accepted, never dispatched: not sent.
  expect(notices.noticeOf('op-remote')?.certainty).toBe('not-sent')
  await answer
})
