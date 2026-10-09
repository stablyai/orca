import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'

function setup() {
  const sendRequest = vi.fn<
    (method: string, params: unknown, options: unknown) => Promise<unknown>
  >(async () => ({
    ok: true,
    result: { ok: true, value: { command: 'compact', state: 'completed' } }
  }))
  const input: Parameters<typeof dispatchMobileStructuredCommand>[0] = {
    text: '/compact',
    hasAttachments: false,
    client: { sendRequest } as unknown as RpcClient,
    sessionId: 'session',
    fence: 1,
    pending: { current: false },
    controller: {
      agent: 'codex',
      snapshot: [],
      invokeAction: vi.fn(async () => true),
      setOption: vi.fn(async () => true),
      conversationCommands: ['clear', 'compact']
    },
    busy: () => null,
    waitsInLine: () => false,
    onError: vi.fn(),
    timeoutMs: 15000
  }
  return { input, sendRequest }
}
/** The fields one recorded request carried, read without asserting their shape. */
function requestFields(call: readonly unknown[] | undefined): Record<string, unknown> {
  const params = call?.[1]
  return typeof params === 'object' && params !== null
    ? Object.fromEntries(Object.entries(params))
    : {}
}
describe('mobile structured conversation commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it.each(['turnActive', 'messagesUnsettled', 'promptPending'] as const)(
    'names the agent when the host refuses a command for %s',
    async (reason) => {
      const { input, sendRequest } = setup()
      sendRequest.mockResolvedValueOnce({
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_operation_invalid',
            message: 'raw host diagnostic',
            details: { reason }
          }
        }
      })
      expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
      expect(input.onError).toHaveBeenCalledWith(
        reason === 'promptPending'
          ? "Answer Codex's question or approval, then run /compact."
          : "Codex is still working. Run /compact when it's done.",
        undefined
      )
    }
  )
  it.each(['/clear', '/compact'])(
    'uses the command RPC for %s without an ordinary send',
    async (text) => {
      const { input, sendRequest } = setup()
      expect(await dispatchMobileStructuredCommand({ ...input, text })).toBe('accepted')
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.conversationCommand',
        expect.objectContaining({ command: text.slice(1) }),
        expect.anything()
      )
    }
  )
  it.each([
    [
      'the host reports the command unconfirmed',
      { ok: true, result: { ok: true, value: { command: 'compact', state: 'unknown' } } }
    ],
    [
      'the host cannot say what became of it',
      {
        ok: true,
        result: {
          ok: false,
          refusal: { code: 'agent_session_operation_unknown', message: 'unconfirmed' }
        }
      }
    ],
    [
      'the host fails after starting it',
      { ok: false, error: { code: 'runtime_error', message: 'settlement failed' } }
    ]
  ])('sends the next press as a new command after %s', async (_case, answer) => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce(answer)
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    // Only the operation id differs between the two requests.
    expect(sendRequest.mock.calls[1]?.[1]).not.toEqual(sendRequest.mock.calls[0]?.[1])
  })
  it.each(['attachments', 'old host', 'arguments', 'pending work'])(
    'guards %s without provider dispatch',
    async (reason) => {
      const { input, sendRequest } = setup()
      if (reason === 'attachments') {
        input.hasAttachments = true
      }
      if (reason === 'old host') {
        input.controller.conversationCommands = undefined
      }
      if (reason === 'arguments') {
        input.text = '/compact instructions'
      }
      if (reason === 'pending work') {
        input.busy = () => 'working'
      }
      expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
      expect(sendRequest).not.toHaveBeenCalled()
      expect(input.onError).toHaveBeenCalled()
    }
  )
  it('/clear is a plain command on every host: no withdrawal fields, nothing persisted', async () => {
    // The host carries queued cards to the replacement session itself; the
    // client asks for nothing back and has nothing to restore.
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('accepted')
    const fields = requestFields(sendRequest.mock.calls[0])
    expect(Object.keys(fields).sort()).toEqual(['command', 'envelope'])
    expect(fields.command).toBe('clear')
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })
  it('a /compact the host holds in line skips the busy check, asks to wait, and shows nothing', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        value: {
          command: 'compact',
          state: 'completed',
          queued: { messageId: 'op', position: 1, state: 'waiting' }
        }
      }
    })
    input.busy = () => 'working'
    input.waitsInLine = (command) => command === 'compact'
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    const fields = requestFields(sendRequest.mock.calls[0])
    expect(fields).toMatchObject({ command: 'compact', delivery: 'queue-if-active' })
    expect(input.onError).not.toHaveBeenCalled()
    // A /clear never waits: the busy check still answers it.
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('rejected')
    expect(sendRequest).toHaveBeenCalledOnce()
  })
  it('a /clear while the agent works says so in plain words', async () => {
    const { input, sendRequest } = setup()
    input.busy = () => 'working'
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "Codex is still working. Run /clear when it's done.",
      { refusedWhile: 'working' }
    )
    input.busy = () => 'prompt'
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "Answer Codex's question or approval, then run /clear.",
      { refusedWhile: 'prompt' }
    )
    input.busy = () => 'working'
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "Codex is still working. Run /compact when it's done.",
      { refusedWhile: 'working' }
    )
    expect(sendRequest).not.toHaveBeenCalled()
  })
  it("a host's refusal names its cause only when the phone showed it at the press", async () => {
    const { input, sendRequest } = setup()
    const refused = {
      ok: true,
      result: {
        ok: true,
        value: {
          command: 'compact',
          state: 'completed',
          error: "Codex is still working. Run /compact when it's done.",
          failure: {
            kind: 'commandRefused',
            refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
          }
        }
      }
    }
    sendRequest.mockResolvedValue(refused)
    input.waitsInLine = () => true
    input.busy = () => 'working'
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "Codex is still working. Run /compact when it's done.",
      { refusedWhile: 'working' }
    )
    // Ahead of the phone: said as any failure, so it can't go before it is read.
    input.busy = () => null
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "Codex is still working. Run /compact when it's done.",
      undefined
    )
  })
  it('keeps ordinary messages on the existing send path', async () => {
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: 'hello' })).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
