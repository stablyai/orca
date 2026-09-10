import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import * as ownership from './mobile-native-chat-draft-ownership'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'

const mocks = vi.hoisted(() => ({ heal: vi.fn(), clear: vi.fn(), send: vi.fn() }))
vi.mock('./mobile-native-chat-stale-input', () => ({ healMobileNativeChatStaleInput: mocks.heal }))
vi.mock('./mobile-native-chat-send', () => ({
  clearMobileNativeChatInput: mocks.clear,
  sendMobileNativeChatMessageWithOutcome: mocks.send,
  typeMobileNativeChatCommandWithOutcome: mocks.send,
  openMobileNativeChatSendBudget: () => Date.now() + 15_000
}))

let renderer: ReactTestRenderer
let drafts: ReturnType<typeof useMobileNativeChatDrafts>
let send: (text: string) => Promise<MobileNativeChatSendOutcome>
let observed: ownership.MobileNativeChatDraftOwnership
const reduce = ownership.reduceMobileNativeChatDraftOwnership

function Harness({
  kind,
  tab = 'a',
  enabled = true
}: {
  kind: 'pty' | 'structured'
  tab?: string | null
  enabled?: boolean
}) {
  drafts = useMobileNativeChatDrafts({
    hostId: 'host',
    worktreeId: 'folder',
    tabId: tab,
    sessionId: null,
    messages: [],
    transcriptSettled: true
  })
  const onSendError = vi.fn()
  const pty = useMobileNativeChatMessageSend({
    ...drafts,
    client: {} as never,
    enabled,
    handleRef: { current: 'synthetic-terminal' },
    deviceTokenRef: { current: null },
    agentRef: { current: 'codex' },
    commandSendRef: { current: vi.fn() },
    onSendError
  })
  const structured = useMobileStructuredNativeChatSendBridge({
    ...drafts,
    sendStructured: mocks.send,
    onSendError
  })
  send = kind === 'pty' ? pty.sendWithOutcome : structured.sendWithOutcome
  return null
}
async function mount(kind: 'pty' | 'structured', tab: string | null = 'a', enabled = true) {
  await act(async () => {
    renderer = create(createElement(Harness, { kind, tab, enabled }))
  })
  await act(async () => drafts.setComposerText('original'))
}
beforeEach(() => {
  mocks.heal.mockReset().mockResolvedValue(true)
  mocks.clear.mockReset().mockResolvedValue(true)
  mocks.send.mockReset().mockResolvedValue('accepted')
  observed = ownership.createMobileNativeChatDraftOwnership()
  vi.spyOn(ownership, 'reduceMobileNativeChatDraftOwnership').mockImplementation(
    (state, action) => {
      observed = reduce(state, action)
      return observed
    }
  )
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  vi.restoreAllMocks()
})

for (const kind of ['pty', 'structured'] as const) {
  describe(`${kind} send origin ownership`, () => {
    it.each(['accepted', 'rejected', 'unknown'] as const)(
      'retires %s chat sends',
      async (outcome) => {
        await mount(kind)
        mocks.send.mockResolvedValue(outcome)
        await act(async () => {
          expect(await send('original')).toBe(outcome)
        })
        expect(drafts.composerText).toBe(outcome === 'rejected' ? 'original' : '')
        expect(observed.origins.size).toBe(0)
      }
    )
    it.each(['accepted', 'rejected', 'unknown'] as const)(
      'retires %s command sends',
      async (outcome) => {
        await mount(kind)
        await act(async () => drafts.setComposerText('/clear'))
        mocks.send.mockResolvedValue(outcome)
        await act(async () => {
          expect(await send('/clear')).toBe(outcome)
        })
        const restored = outcome === 'rejected' || (kind === 'structured' && outcome === 'unknown')
        expect(drafts.composerText).toBe(restored ? '/clear' : '')
        expect(observed.origins.size).toBe(0)
      }
    )
    it('retires a throwing transport without inventing a definite rejection', async () => {
      await mount(kind)
      mocks.send.mockRejectedValue(new Error('synthetic transport throw'))
      await act(async () => {
        await expect(send('original')).rejects.toThrow('synthetic transport throw')
      })
      expect(observed.origins.size).toBe(0)
    })
    it('restores across navigation but preserves edits made after a second capture', async () => {
      await mount(kind)
      let settle: (value: MobileNativeChatSendOutcome) => void = () => {}
      mocks.send.mockImplementation(
        () =>
          new Promise((resolve) => {
            settle = resolve
          })
      )
      let pending: Promise<MobileNativeChatSendOutcome>
      await act(async () => {
        pending = send('original')
      })
      expect(observed.origins.size).toBe(1)
      await act(async () => renderer.update(createElement(Harness, { kind, tab: 'b' })))
      await act(async () => {
        settle('rejected')
        await pending
      })
      expect(observed.origins.size).toBe(0)
      await act(async () => renderer.update(createElement(Harness, { kind, tab: 'a' })))
      expect(drafts.composerText).toBe('original')
      await act(async () => {
        pending = send('original')
      })
      await act(async () => {
        drafts.setComposerText('newer')
        drafts.setComposerText('')
      })
      await act(async () => {
        settle('rejected')
        await pending
      })
      expect(drafts.composerText).toBe('')
      expect(observed.origins.size).toBe(0)
    })
    it('does not allow an old unmounted send to mutate the next hook instance', async () => {
      await mount(kind)
      let settle: (value: MobileNativeChatSendOutcome) => void = () => {}
      mocks.send.mockImplementation(
        () =>
          new Promise((resolve) => {
            settle = resolve
          })
      )
      let pending: Promise<MobileNativeChatSendOutcome>
      await act(async () => {
        pending = send('original')
      })
      await act(async () => renderer.unmount())
      await mount(kind)
      await act(async () => drafts.setComposerText('new instance'))
      await act(async () => {
        settle('rejected')
        await pending
      })
      expect(drafts.composerText).toBe('new instance')
    })
    it('allocates no origin without a tab', async () => {
      await mount(kind, null)
      await act(async () => {
        expect(await send('original')).toBe('rejected')
      })
      expect(observed.origins.size).toBe(0)
      expect(mocks.send).not.toHaveBeenCalled()
    })
  })
}

it.each(['heal rejection', 'heal exception', 'clear rejection', 'clear exception', 'disconnected'])(
  'releases PTY capture on %s',
  async (failure) => {
    await mount('pty', 'a', failure !== 'disconnected')
    if (failure === 'heal rejection') {
      mocks.heal.mockResolvedValue(false)
    }
    if (failure === 'clear rejection') {
      mocks.clear.mockResolvedValue(false)
    }
    if (failure === 'heal exception') {
      mocks.heal.mockRejectedValue(new Error('heal'))
    }
    if (failure === 'clear exception') {
      mocks.clear.mockRejectedValue(new Error('clear'))
    }
    await act(async () => {
      if (failure.endsWith('exception')) {
        await expect(send('original')).rejects.toThrow()
      } else {
        expect(await send('original')).toBe('rejected')
      }
    })
    expect(observed.origins.size).toBe(0)
    expect(mocks.send).not.toHaveBeenCalled()
  }
)
