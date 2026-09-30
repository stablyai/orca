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
    sessionKey: 'session:1',
    pending: { current: false },
    operationIds: new Map(),
    controller: {
      agent: 'codex',
      snapshot: [],
      invokeAction: vi.fn(async () => true),
      setOption: vi.fn(async () => true),
      conversationCommands: ['clear', 'compact']
    },
    canRun: () => true,
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
      expect(input.operationIds.size).toBe(0)
    }
  )
  it('retains the exact operation ID after an unknown response', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: { command: 'compact', state: 'unknown' } }
    })
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })
  it('retains operation identity when the host explicitly reports an unknown ledger outcome', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: false,
        refusal: { code: 'agent_session_operation_unknown', message: 'unconfirmed' }
      }
    } as never)
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })
  it('retains operation identity when the host fails after starting the command', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: false,
      error: { code: 'runtime_error', message: 'settlement failed' }
    } as never)
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
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
        input.canRun = () => false
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
  it('keeps ordinary messages on the existing send path', async () => {
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: 'hello' })).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
