import { buildTerminalSendPayload } from '../../terminal-send-payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const send = vi.hoisted(() => vi.fn())
vi.mock('./terminal/terminal-send-method', () => ({
  TERMINAL_SEND_METHODS: [{ name: 'terminal.send', handler: send }]
}))
import { MOBILE_WEB_NATIVE_CHAT_MUTATION_METHOD as method } from './mobile-web-native-chat-mutations'
import { nativeChatPageFixture } from './mobile-web-native-chat-test-fixture'

function fixture() {
  const f = nativeChatPageFixture()
  return {
    ...f,
    params: {
      ...f.scope,
      action: 'sendMessage' as const,
      text: 'hello',
      timeoutMs: 15_000
    }
  }
}
beforeEach(() =>
  send.mockReset().mockResolvedValue({ send: { accepted: true, handle: 'private-terminal' } })
)

describe('host-owned chat actions', () => {
  it('uses authenticated identity and the authoritative terminal without returning host handles', async () => {
    const f = fixture()
    const params = method.params!.parse({
      ...f.params,
      terminal: 'forged',
      client: { id: 'forged' },
      clearInputFirst: true
    })
    expect(await method.handler(params, f.context)).toEqual({ outcome: 'accepted' })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: 'host-terminal',
        text: '\x15hello',
        enter: true,
        client: { id: 'authenticated-device-token', type: 'mobile' }
      }),
      f.context
    )
  })
  it('sends stop without Return and clears input before commit', async () => {
    const f = fixture()
    expect(await method.handler({ ...f.params, action: 'stop' }, f.context)).toEqual({
      outcome: 'accepted'
    })
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '\x1b', enter: false }),
      f.context
    )
    expect(await method.handler({ ...f.params, action: 'prepareCommit' }, f.context)).toEqual({
      prepared: true
    })
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '\x15', enter: false }),
      f.context
    )
  })
  it('keeps dispatch errors and malformed acknowledgements delivery-ambiguous', async () => {
    const f = fixture()
    send.mockRejectedValueOnce(new Error('Lost acknowledgement'))
    expect(await method.handler(f.params, f.context)).toEqual({ outcome: 'unknown' })
    send.mockResolvedValueOnce({ future: true })
    expect(await method.handler(f.params, f.context)).toEqual({ outcome: 'unknown' })
    send.mockResolvedValueOnce({ send: { accepted: false } })
    expect(await method.handler(f.params, f.context)).toEqual({ outcome: 'rejected' })
  })
  it('does not write against a replaced transcript binding or an exhausted budget', async () => {
    const f = fixture()
    f.listMobileSessionTabs.mockResolvedValue({ worktree: 'host-workspace', tabs: [] })
    await expect(method.handler(f.params, f.context)).rejects.toThrow('selector_not_found')
    f.listMobileSessionTabs.mockResolvedValue({ worktree: 'host-workspace', tabs: [f.tab] })
    expect(await method.handler({ ...f.params, timeoutMs: 1 }, f.context)).toEqual({
      outcome: 'rejected'
    })
    expect(send).not.toHaveBeenCalled()
  })
  it('resolves the transcript binding once for a whole typed command', async () => {
    const f = fixture()
    expect(
      await method.handler({ ...f.params, text: '/go', typeCommand: true }, f.context)
    ).toEqual({ outcome: 'accepted' })
    expect(send.mock.calls.length).toBeGreaterThan(1)
    expect(f.listMobileSessionTabs).toHaveBeenCalledOnce()
  })
  it('paces command keys and attaches the launch draft only to the final submit', async () => {
    const f = fixture()
    const draft = { text: 'draft', createdAt: 1 }
    const result = await method.handler(
      { ...f.params, text: '/😀', typeCommand: true, resolvedLaunchDraft: draft },
      f.context
    )
    expect(result).toEqual({ outcome: 'accepted' })
    expect(send.mock.calls.map(([params]) => buildTerminalSendPayload(params))).toEqual([
      '\x15',
      '/',
      '😀',
      '\r'
    ])
    expect(
      send.mock.calls.slice(0, -1).every(([params]) => params.resolvedLaunchDraft === undefined)
    ).toBe(true)
    expect(send.mock.calls.at(-1)![0].resolvedLaunchDraft).toEqual(draft)
  })
  it('stops a command sequence when its document disconnects', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.context.signal = controller.signal
    send.mockImplementationOnce(async () => {
      controller.abort()
      return { send: { accepted: true } }
    })
    expect(await method.handler({ ...f.params, typeCommand: true }, f.context)).toEqual({
      outcome: 'rejected'
    })
    expect(send).toHaveBeenCalledOnce()
  })
})
