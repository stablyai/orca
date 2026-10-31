import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mobileNativeChatPromptDismissals } from './native-chat/input/mobile-native-chat-prompt-dismissals'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import type { RpcResponse } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { AskPrompt } from '../../../src/shared/native-chat/input/native-chat-ask-types'
import {
  visible,
  session,
  structuredSession,
  handleRef,
  baseTab,
  permissionTab,
  response,
  render,
  reset,
  unmount,
  sendButton,
  permissionAction,
  getController,
  askCancel,
  askAnswer,
  askCollapse,
  sendError,
  getTree
} from './__mocks__/mobile-prompt-controller'

const client: RpcClient = {
  sendRequest: vi.fn<RpcClient['sendRequest']>(),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

beforeEach(() => {
  vi.mocked(client.sendRequest).mockReset().mockResolvedValue(response())
  reset(client)
})
afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('prompt cards through the production controller, send contract and view', () => {
  it('finishes an older-host selector once and dismisses it like an acknowledged answer', async () => {
    vi.useFakeTimers()
    const prompt: AskPrompt = {
      questions: [{ question: 'Answer?', options: [{ label: 'A' }], multiSelect: false }]
    }
    const selections = [{ indices: [], other: 'custom answer' }]
    vi.mocked(client.sendRequest).mockResolvedValue(response(true, 'legacy'))
    await render({
      tab: {
        ...baseTab,
        agentStatus: {
          ...baseTab.agentStatus,
          toolName: 'AskUserQuestion',
          interactivePrompt: JSON.stringify(prompt)
        }
      }
    })
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = askAnswer(selections)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await expect(pending).resolves.toBe(true)
    })
    const writes = vi
      .mocked(client.sendRequest)
      .mock.calls.filter(([method]) => method === 'terminal.send')
      .map(([, params]) => params)
    expect(writes).toEqual(
      ['2', 'custom answer', '\r'].map((text) =>
        expect.objectContaining({
          text,
          enter: false,
          requireWriteSettlement: true
        })
      )
    )
    expect(getController().nativeChatAsk).toBe(null)
    expect(sendButton().props.disabled).toBe(false)
    expect(sendError).not.toHaveBeenCalled()
  })

  it.each([0, 1])(
    'dismisses older-host approval choice %i like an acknowledged answer and restores Send',
    async (choice) => {
      vi.mocked(client.sendRequest).mockResolvedValue(response(true, 'legacy'))
      await render({ tab: permissionTab })
      await act(async () => {
        await permissionAction(choice).props.onPress()
      })
      expect(getController().nativeChatPermission).toBe(null)
      expect(sendButton().props.disabled).toBe(false)
      expect(sendError).not.toHaveBeenCalled()
      expect(client.sendRequest).toHaveBeenCalledOnce()
    }
  )

  it.each(['refused', 'unverifiable'] as const)(
    'retains permission choices on %s',
    async (mode) => {
      vi.mocked(client.sendRequest).mockResolvedValue(response(false, mode))
      await render({ tab: permissionTab })
      await act(async () => {
        await permissionAction().props.onPress()
      })
      expect(getController().nativeChatPermission).not.toBe(null)
      expect(permissionAction().props.disabled).toBe(false)
      expect(sendButton().props.disabled).toBe(true)
      expect(client.sendRequest).toHaveBeenCalledWith(
        'terminal.send',
        expect.objectContaining({ requireWriteSettlement: true, enter: false, text: '\x1b' }),
        expect.any(Object)
      )
    }
  )

  it.each(['permission', 'ask'])(
    'acknowledges the same pending %s after a view-only toggle',
    async (kind) => {
      const tab =
        kind === 'permission'
          ? permissionTab
          : {
              ...baseTab,
              agentStatus: {
                ...baseTab.agentStatus,
                toolName: 'AskUserQuestion',
                interactivePrompt: JSON.stringify({
                  questions: [
                    {
                      question: 'Pick destination?',
                      options: [{ label: 'East' }, { label: 'West' }]
                    }
                  ]
                })
              }
            }
      let finish: (reply: RpcResponse) => void = () => {
        throw new Error('write not started')
      }
      vi.mocked(client.sendRequest).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await render({ tab })
      let action: Promise<boolean> | undefined
      act(() => {
        action = kind === 'permission' ? permissionAction().props.onPress() : askCancel()
      })
      visible.value = false
      await render({ tab })
      visible.value = true
      await render({ tab })
      await act(async () => {
        finish(response())
        await action
      })
      expect(getController().nativeChatPermission).toBe(null)
      expect(getController().nativeChatAsk).toBe(null)
      expect(sendButton().props.disabled).toBe(false)
    }
  )

  it('collapses a permission to a strip without writing, and expands it back', async () => {
    await render({ tab: permissionTab })
    act(() => {
      getTree().root.findByProps({ accessibilityLabel: 'Collapse' }).props.onPress()
    })
    expect(getController().nativeChatPermission).not.toBe(null)
    expect(getController().nativeChatCollapsedPrompt?.title).toBeTruthy()
    expect(getTree().root.findAllByProps({ testID: 'native-chat-prompt-strip' })).toHaveLength(1)
    expect(sendButton().props.disabled).toBe(false)
    act(() => {
      getTree().root.findByProps({ accessibilityLabel: 'Expand' }).props.onPress()
    })
    expect(getController().nativeChatPermission).not.toBe(null)
    expect(sendButton().props.disabled).toBe(true)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('shows a collapsed prompt again as a new wait', async () => {
    await render({ tab: permissionTab })
    act(() => {
      getTree().root.findByProps({ accessibilityLabel: 'Collapse' }).props.onPress()
    })
    await render({
      tab: { ...permissionTab, agentStatus: { ...permissionTab.agentStatus, stateStartedAt: 20 } }
    })
    expect(getController().nativeChatPermission).not.toBe(null)
    expect(getController().nativeChatCollapsedPrompt).toBe(null)
  })

  it('collapses an ask to a strip without writing', async () => {
    await render({
      tab: {
        ...baseTab,
        agentStatus: {
          ...baseTab.agentStatus,
          toolName: 'AskUserQuestion',
          interactivePrompt: JSON.stringify({
            questions: [{ question: 'Pick?', options: [{ label: 'East' }] }]
          })
        }
      }
    })
    act(() => {
      askCollapse()
    })
    expect(getController().nativeChatAsk).not.toBe(null)
    expect(getController().nativeChatCollapsedPrompt?.title).toBe('Pick?')
    expect(sendButton().props.disabled).toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('keeps an acknowledged Deny hidden after the chat screen remounts on a lingering status', async () => {
    await render({ tab: permissionTab })
    await act(async () => {
      await permissionAction().props.onPress()
    })
    expect(sendButton().props.disabled).toBe(false)
    await unmount()
    await render({
      tab: { ...permissionTab, agentStatus: { ...permissionTab.agentStatus, updatedAt: 99 } }
    })
    expect(getController().nativeChatPermission).toBe(null)
    expect(sendButton().props.disabled).toBe(false)
  })

  it.each(['prompt', 'session', 'PTY', 'tab', 'clear'])(
    'drops an accepted result after real %s replacement',
    async (replacement) => {
      let finish: (reply: RpcResponse) => void = () => {
        throw new Error('write not started')
      }
      vi.mocked(client.sendRequest).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await render({ tab: permissionTab })
      act(() => {
        void permissionAction().props.onPress()
      })
      const agentStatus: NonNullable<typeof permissionTab.agentStatus> = {
        ...permissionTab.agentStatus
      }
      if (replacement === 'prompt') {
        agentStatus.stateStartedAt = 20
      }
      if (replacement === 'session') {
        agentStatus.providerSession = { id: 'session-2', key: 'session_id' }
      }
      if (replacement === 'PTY') {
        handleRef.current = 'term-2'
      }
      if (replacement === 'clear') {
        await render({
          tab: { ...baseTab, agentStatus: { ...baseTab.agentStatus, state: 'working' } }
        })
      }
      await render({
        tab: { ...permissionTab, agentStatus },
        tabId: replacement === 'tab' ? 'tab-2' : 'tab-1'
      })
      await act(async () => {
        finish(response())
      })
      expect(getController().nativeChatPermission).not.toBe(null)
      expect(permissionAction().props.disabled).toBe(false)
      expect(sendButton().props.disabled).toBe(true)
    }
  )
})

vi.mock('./MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))
vi.mock('../composer-usage/ComposerUsageMeter', () => ({ ComposerUsageSlot: () => null }))

describe('async occurrences through the phone controller and rendered card actions', () => {
  const row = (id: string, title = 'Q1?', callId?: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        callId,
        input: { questions: [{ title, options: ['Red', 'Blue'] }] }
      }
    ]
  })
  const structuredTab = {
    type: 'agent-session',
    id: 'tab-1',
    title: 'Chat',
    sessionId: 'session-1',
    agent: 'codex',
    isActive: true
  }
  const terminalTab = {
    ...baseTab,
    launchAgent: 'codex',
    agentStatus: { ...baseTab.agentStatus, agentType: 'codex' }
  }
  const titles = () => getController().nativeChatAsk?.questions.map((q) => q.question)

  it.each(['structured', 'terminal'])(
    'keeps an agent notice answerable and retires only human input through the %s view',
    async (kind) => {
      const tab = kind === 'structured' ? structuredTab : terminalTab
      const q1 = row('one')
      const notice: NativeChatMessage = {
        id: 'mail',
        role: 'user',
        timestamp: 2,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
        from: {
          kind: 'agent',
          senders: [
            {
              party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
              name: 'Coder'
            }
          ],
          orchestration: {
            message: 'mail-notice',
            mailbox: 'term_b',
            dispatchId: null,
            messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'term_a' }]
          }
        }
      }
      session.messages = [q1, notice]
      await render({ tab })
      expect(titles()).toEqual(['Q1?'])
      await act(async () => {
        await askAnswer([{ indices: [1] }])
      })
      if (kind === 'structured') {
        expect(structuredSession.sendWithOutcome).toHaveBeenCalledWith('> Q1?\n\nBlue')
        expect(titles()).toEqual(['Q1?'])
      } else {
        expect(client.sendRequest).toHaveBeenCalledWith(
          'terminal.send',
          expect.objectContaining({
            text: '\x1b[200~> Q1?\r\rBlue\x1b[201~',
            enter: true,
            requireWriteSettlement: true
          }),
          expect.any(Object)
        )
      }
      const q2 = row('two', 'Q2?')
      session.messages = [q1, notice, q2]
      await render({ tab })
      expect(titles()).toContain('Q2?')
      session.messages = [q1, notice, q2, { ...notice, id: 'human', from: undefined }]
      await render({ tab })
      expect(titles()).toBeUndefined()
    }
  )

  it.each(['structured', 'terminal'])(
    'retains exact cancelled calls through edits, prefix/ID replay, paging and new equal rows (%s)',
    async (kind) => {
      const tab = kind === 'structured' ? structuredTab : terminalTab
      const q1 = row('one', 'Q1?', 'raw-call')
      session.messages = [q1]
      await render({ tab })
      await act(async () => {
        await askCancel()
      })
      expect(titles()).toBeUndefined()
      for (const callId of ['renumbered', undefined]) {
        session.messages = [
          {
            ...row('one', 'Edited Q1?', callId),
            blocks: [
              { type: 'text', text: 'prefix' },
              { type: 'tool-call', name: 'Bash', input: {} },
              ...row('one', 'Edited Q1?', callId).blocks,
              ...row('one', 'Q2?').blocks
            ]
          }
        ]
        await render({ tab })
        expect(titles()).toEqual(['Q2?'])
      }
      await act(async () => {
        await askCancel()
      })
      session.messages = []
      await render({ tab })
      session.messages = [q1]
      await render({ tab })
      expect(titles()).toBeUndefined()
      await unmount()
      await render({ tab })
      expect(titles()).toBeUndefined()
      session.messages = [q1, row('new-equal-row')]
      await render({ tab })
      expect(titles()).toEqual(['Q1?'])
      expect(client.sendRequest).not.toHaveBeenCalled()
      expect(structuredSession.sendWithOutcome).not.toHaveBeenCalled()
    }
  )

  it.each(['accepted', 'queued', 'unknown', 'rejected'] as const)(
    'keeps structured %s admission separate from captured Cancel and delivered rows',
    async (outcome) => {
      let finish: (result: 'accepted' | 'queued' | 'unknown' | 'rejected') => void = () => {
        throw new Error('not sent')
      }
      structuredSession.sendWithOutcome.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const q1 = row('one')
      session.messages = [q1]
      await render({ tab: structuredTab })
      let answer: Promise<boolean> | undefined
      act(() => {
        answer = askAnswer([{ indices: [1] }])
      })
      session.messages = [q1, row('two', 'Q2?')]
      await render({ tab: structuredTab })
      expect(titles()).toEqual(['Q1?', 'Q2?'])
      await act(async () => {
        finish(outcome)
        await answer
      })
      expect(titles()).toEqual(['Q1?', 'Q2?'])
      session.messages = [
        q1,
        row('two', 'Q2?'),
        {
          id: 'delivered',
          role: 'user',
          timestamp: null,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Blue' }]
        }
      ]
      await render({ tab: structuredTab })
      expect(titles()).toBeUndefined()
      expect(structuredSession.sendWithOutcome).toHaveBeenCalledWith('> Q1?\n\nBlue')
    }
  )

  it('settles the terminal answer for Q1 after Q2 arrives without hiding Q2', async () => {
    let finish: (reply: RpcResponse) => void = () => {
      throw new Error('not sent')
    }
    vi.mocked(client.sendRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const q1 = row('one')
    session.messages = [q1]
    await render({ tab: terminalTab })
    let answer: Promise<boolean> | undefined
    await act(async () => {
      answer = askAnswer([{ indices: [1] }])
    })
    session.messages = [q1, row('two', 'Q2?')]
    await render({ tab: terminalTab })
    await act(async () => {
      finish(response())
      await answer
    })
    expect(titles()).toEqual(['Q2?'])
  })

  it.each(['source', 'reset', 'view'])(
    'fences a late captured structured answer after %s replacement',
    async (replacement) => {
      let finish: (outcome: 'accepted') => void = () => {
        throw new Error('not sent')
      }
      structuredSession.sendWithOutcome.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      session.messages = [row('one')]
      await render({ tab: structuredTab })
      let answer: Promise<boolean> | undefined
      act(() => {
        answer = askAnswer([{ indices: [1] }])
      })
      if (replacement !== 'view') {
        structuredSession.asyncQuestionSourceScope = `journal/${replacement}/session/epoch`
      }
      await render({ tab: structuredTab, tabId: replacement === 'view' ? 'tab-2' : 'tab-1' })
      await act(async () => {
        finish('accepted')
        await answer
      })
      expect(titles()).toEqual(['Q1?'])
    }
  )
  it.each(['pending', 'rejected', 'withdrawn'] as const)(
    'does not turn real %s host-result conversion into an answered question',
    async (kind) => {
      const value = structuredSendResultFixture(
        kind === 'pending' ? 'pending' : 'rejected',
        kind === 'withdrawn'
          ? 'This message was withdrawn before the agent started it.'
          : 'provider_write_failed: broken pipe'
      )
      if (kind === 'withdrawn' && 'submission' in value) {
        value.submission.rejection = { kind: 'cancelled' }
      }
      const converted = mobileStructuredSendDelivery({ status: 'accepted', value })
      expect(converted.outcome).toBe('accepted')
      structuredSession.sendWithOutcome.mockResolvedValue(converted.outcome)
      session.messages = [row('one')]
      await render({ tab: structuredTab })
      await act(async () => {
        await expect(askAnswer([{ indices: [1] }])).resolves.toBe(true)
      })
      expect(titles()).toEqual(['Q1?'])
    }
  )

  it('keeps later same-ID Cancel after eviction/reentry and old answer settlement', async () => {
    let finish: (outcome: 'accepted') => void = () => {
      throw new Error('not sent')
    }
    structuredSession.sendWithOutcome.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    session.messages = [row('one')]
    await render({ tab: structuredTab })
    let answer: Promise<boolean> | undefined
    act(() => {
      answer = askAnswer([{ indices: [1] }])
    })
    act(() => {
      for (let index = 0; index < 128; index += 1) {
        mobileNativeChatPromptDismissals.hideAsync(`other-${index}`, ['other'])
      }
    })
    await unmount()
    await render({ tab: structuredTab })
    await act(async () => {
      await askCancel()
    })
    await act(async () => {
      finish('accepted')
      await answer
    })
    expect(titles()).toBeUndefined()
  })

  it('keeps structured answer controls after a thrown send', async () => {
    structuredSession.sendWithOutcome.mockRejectedValue(new Error('send failed'))
    session.messages = [row('one')]
    await render({ tab: structuredTab })
    await act(async () => {
      await expect(askAnswer([{ indices: [1] }])).rejects.toThrow('send failed')
    })
    expect(titles()).toEqual(['Q1?'])
  })

  it('isolates equal portable IDs on two hosts and rejects the old host callback', async () => {
    session.messages = [row('one')]
    await render({ tab: structuredTab, hostId: 'host-A' })
    const ids = getController().nativeChatAsk?.occurrenceIds
    const oldCancel = getController().dismissNativeChatAsk
    await render({ tab: structuredTab, hostId: 'host-B' })
    expect(getController().nativeChatAsk?.occurrenceIds).toEqual(ids)
    act(oldCancel)
    expect(titles()).toEqual(['Q1?'])
    await act(async () => {
      await askCancel()
    })
    await render({ tab: structuredTab, hostId: 'host-A' })
    expect(titles()).toEqual(['Q1?'])
    await act(async () => {
      await askCancel()
    })
    await render({ tab: structuredTab, hostId: 'host-B' })
    expect(titles()).toBeUndefined()
  })
})
