import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  dispatchMobileStructuredCommand,
  type MobileStructuredCommandHolds
} from './mobile-structured-composer-command'

const IDLE: MobileStructuredCommandHolds = {
  working: false,
  prompt: false,
  background: false,
  backgroundTasksRunning: false,
  sending: false
}
const holding = (shown: Partial<MobileStructuredCommandHolds>) => () => ({ ...IDLE, ...shown })

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
    holds: () => IDLE,
    startFailures: () => [],
    waitsInLine: () => false,
    onError: vi.fn(),
    timeoutMs: 15000
  }
  return { input, sendRequest }
}
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
        input.holds = holding({ working: true })
      }
      expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
      expect(sendRequest).not.toHaveBeenCalled()
      expect(input.onError).toHaveBeenCalled()
    }
  )
  it('leaves a session-reported command such as OMP /fast to an ordinary send', async () => {
    const { input, sendRequest } = setup()
    input.text = '/fast'
    input.controller.agent = 'omp'
    expect(await dispatchMobileStructuredCommand(input)).toBeNull()
    expect(input.onError).not.toHaveBeenCalled()
    input.controller.sessionCommands = [{ name: 'fast', kind: 'command' }]
    expect(await dispatchMobileStructuredCommand(input)).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
  it('/clear is a plain command on every host: no withdrawal fields, nothing persisted', async () => {
    // The host carries cards to replacement sessions; client restoration would duplicate them.
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
    input.holds = holding({ working: true })
    input.waitsInLine = (command) => command === 'compact'
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    const fields = requestFields(sendRequest.mock.calls[0])
    expect(fields).toMatchObject({ command: 'compact', delivery: 'queue-if-active' })
    expect(input.onError).not.toHaveBeenCalled()
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('rejected')
    expect(sendRequest).toHaveBeenCalledOnce()
  })
  it('a /clear while the agent works says so in plain words', async () => {
    const { input, sendRequest } = setup()
    input.holds = holding({ working: true })
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "The agent is still working. Run /clear when it's done.",
      { refusedWhile: 'working' }
    )
    input.holds = holding({ prompt: true })
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "Answer the agent's question or approval, then run /clear.",
      { refusedWhile: 'prompt' }
    )
    input.holds = holding({ working: true })
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "The agent is still working. Run /compact when it's done.",
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
          error: "The agent is still working. Run /compact when it's done.",
          failure: {
            kind: 'commandRefused',
            refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
          }
        }
      }
    }
    sendRequest.mockResolvedValue(refused)
    input.waitsInLine = () => true
    input.holds = holding({ working: true })
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "The agent is still working. Run /compact when it's done.",
      { refusedWhile: 'working' }
    )
    // Keep a newer host’s unreadable cause as failure rather than claiming which work blocked it.
    input.holds = () => IDLE
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      "The agent is still working. Run /compact when it's done.",
      undefined
    )
  })
  it('holds for background tasks or a message still sending, and waits silently behind one in line', async () => {
    const { input, sendRequest } = setup()
    input.holds = holding({ background: true, backgroundTasksRunning: true })
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      'Wait for pending work and messages to finish before using this command.',
      { refusedWhile: 'background' }
    )
    input.holds = holding({ sending: true })
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).toHaveBeenLastCalledWith(
      'Your earlier message is still being sent. Run /compact once it has gone.',
      { refusedWhile: 'sending' }
    )
    input.waitsInLine = () => true
    vi.mocked(input.onError).mockClear()
    expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
    expect(input.onError).not.toHaveBeenCalled()
    expect(sendRequest).not.toHaveBeenCalled()
  })
  it('keeps ordinary messages on the existing send path', async () => {
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: 'hello' })).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
