import {
  updateMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import type { RpcClient } from '../transport/rpc-client'
import {
  fieldsOf,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import { useMobileNativeChatDrafts } from './native-chat/composer/use-mobile-native-chat-drafts'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import {
  AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY
} from '../../../src/shared/agent-session-create-capabilities'
import {
  structuredAgentSessionHostSupport,
  type StructuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { mobileNativeChatUnsentNotices } from './mobile-native-chat-unsent-notices'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import {
  useMobileNativeChatSendError,
  type MobileNativeChatSendErrorDetails
} from './native-chat/use-mobile-native-chat-send-error'

import capture from '../../../src/shared/__fixtures__/omp-native-commands.json'
import { useMobileNativeChatComposerMenu } from './native-chat/composer/use-mobile-native-chat-composer-menu'
vi.mock('./native-chat/composer/MobileNativeChatComposerMenu', () => ({
  composerMenuInsertText: (row: { token: string }) => row.token
}))

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

function sendResult(dispatchState: AgentJournalDispatchState, reason: string | null = null) {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: structuredSendResultFixture(dispatchState, reason)
  })
}

describe('mobile structured send actions', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let banner: ReturnType<typeof useMobileNativeChatSendError> | null = null
  let menu: ReturnType<typeof useMobileNativeChatComposerMenu>
  let draft = ''
  let listener: ((value: unknown) => void) | null = null
  let storedOperations: Map<string, string>
  let agent = 'codex'
  let sessionCommands: readonly AgentSessionSlashCommand[] | undefined
  let sendOrdinary: ReturnType<typeof useMobileStructuredNativeChatSendBridge>['sendWithOutcome']
  let hostSupport: StructuredAgentSessionHostSupport | null = null
  const onSendError = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
    if (_method === 'agentSession.subscribe') {
      listener = onData
    }
    return vi.fn()
  })
  const client: RpcClient = {
    sendRequest,
    subscribe,
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }

  function Harness() {
    const [value, onChangeText] = useState('/skill:pl')
    draft = value
    menu = useMobileNativeChatComposerMenu({
      value,
      onChangeText,
      agent,
      structuredCatalog: {
        conversationCommands: [],
        reported: capture.enabled.availableCommands.map((row) => ({
          name: row.name,
          description: row.description,
          kind: 'command' as const
        }))
      },
      filePaths: [],
      focusField: vi.fn()
    })
    banner = useMobileNativeChatSendError({ scopeKey: 'session-1', showToast: vi.fn() })
    banner.bannerMountedRef.current = true
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      composerScopeKey: 'ordinary-draft',
      enabled: true,
      connected: true,
      agent,
      sessionCommands,
      hostSupport,
      onSendError
    })
    return createElement('span', null, banner.message)
  }

  function BridgeHarness() {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host-a',
      worktreeId: 'workspace-a',
      tabId: 'performance',
      sessionId: 'session-1',
      messages: [],
      transcriptSettled: true
    })
    sendOrdinary = useMobileStructuredNativeChatSendBridge({
      ...drafts,
      agent: 'codex',
      sessionCommands,
      sendStructured: (...args) => hook!.sendWithOutcome(...args),
      onSendError
    }).sendWithOutcome
    return createElement(Harness)
  }

  async function mountSession(ordinary = false): Promise<void> {
    act(() => {
      renderer = create(createElement(ordinary ? BridgeHarness : Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))
  }

  function calls() {
    return sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
  }

  function sentIds(): string[] {
    return calls().map(([, params]) =>
      String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    onSendError.mockImplementation((message: string, details?: MobileNativeChatSendErrorDetails) =>
      banner?.show(message, details)
    )

    storedOperations = new Map()
    asyncStorage.getItem.mockImplementation(
      async (key: string) => storedOperations.get(key) ?? null
    )
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      storedOperations.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      storedOperations.delete(key)
    })
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    banner = null
    listener = null
    agent = 'codex'
    sessionCommands = undefined
    hostSupport = null
    resetMobileNativeChatDraftInputsForTests()
  })

  it.each([10, 100])(
    'ordinary phone bridge and Send skip %i commands for prose but still route slash controls',
    async (count) => {
      let kinds = 0
      let names = 0
      sessionCommands = Array.from({ length: count }, (_, index) => ({
        get kind() {
          kinds++
          return 'command' as const
        },
        get name() {
          names++
          return `provider-${index}`
        }
      }))
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.send' ? sendResult('accepted') : ok({})
      )
      await mountSession(true)
      kinds = 0
      names = 0
      await act(async () => {
        expect(await sendOrdinary('hello')).toBe('accepted')
      })
      expect(calls()).toHaveLength(1)
      expect(fieldsOf(calls()[0]![1]).body).toMatchObject({
        blocks: [{ type: 'text', text: 'hello' }]
      })
      expect({ kinds, names }).toEqual({ kinds: 0, names: 0 })
      await act(async () => {
        expect(await sendOrdinary('/compact extra')).toBe('rejected')
      })
      expect(calls()).toHaveLength(1)
      expect(onSendError).toHaveBeenCalledWith('Use /compact without arguments.', undefined)
      expect({ kinds, names }).toEqual({ kinds: 0, names: 0 })
    }
  )

  it('selects a native OMP skill and sends the exact token and arguments through RPC', async () => {
    agent = 'omp'
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('accepted') : ok({})
    )
    await mountSession()
    act(() => menu.onSelectionChange({ start: draft.length, end: draft.length }))
    const skill = menu.rows.find((row) => row.kind === 'skill')!
    expect(skill).toMatchObject({ kind: 'skill', token: '/skill:plan' })
    act(() => menu.pick(skill))
    expect(draft).toBe('/skill:plan ')
    act(() => menu.onFieldChange(`${draft}args`))
    await act(async () => {
      await hook!.sendWithOutcome(draft)
    })
    expect(fieldsOf(calls()[0]![1]).body).toMatchObject({
      blocks: [{ type: 'text', text: '/skill:plan args' }]
    })
  })

  it.each([
    ['carries the shown model and effort to a host that takes them', true],
    ['sends the old shape to a host that does not', false]
  ])('%s', async (_name, takesOptions) => {
    agent = 'claude'
    hostSupport = structuredAgentSessionHostSupport(
      takesOptions ? [AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY] : []
    )
    const high = [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send'
        ? sendResult('accepted')
        : method === 'agentSession.options'
          ? ok({
              models: [{ id: 'opus[1m]', label: 'Opus', isDefault: true, efforts: high }],
              current: { model: 'opus[1m]', effort: 'high' }
            })
          : ok({})
    )
    await mountSession()
    await act(async () => {
      await vi.waitFor(() =>
        expect(sendRequest.mock.calls.some(([method]) => method === 'agentSession.options')).toBe(
          true
        )
      )
    })
    await act(async () => {
      expect(await hook!.sendWithOutcome('hello')).toBe('accepted')
      expect(await hook!.sendWithOutcome('again')).toBe('accepted')
    })
    for (const [, params] of calls()) {
      if (takesOptions) {
        expect(fieldsOf(params).options).toEqual({ model: 'opus[1m]', effort: 'high' })
      } else {
        expect(fieldsOf(params)).not.toHaveProperty('options')
      }
    }
  })

  it("keeps a chat's model its CLI stopped listing, and sends on it and its effort", async () => {
    agent = 'claude'
    hostSupport = structuredAgentSessionHostSupport([AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY])
    const opus = {
      id: 'opus',
      label: 'Opus',
      isDefault: true,
      efforts: [{ value: 'high', label: 'High' }]
    }
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send'
        ? sendResult('accepted')
        : method === 'agentSession.modelCatalog'
          ? ok({ origin: 'probe', fetchedAt: 1, models: [opus] })
          : method === 'agentSession.options'
            ? ok({
                models: [
                  opus,
                  { id: 'opus[1m]', label: 'opus[1m]', isDefault: false, efforts: [] }
                ],
                listedModelIds: ['opus'],
                current: { model: 'opus[1m]', effort: 'max' }
              })
            : ok({})
    )
    await mountSession()
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(
        hook!.optionSnapshot.find((descriptor) => descriptor.id === 'model')?.kind
      ).toMatchObject({ currentValue: 'opus[1m]' })
    })
    expect(hook!.optionSnapshot.find((descriptor) => descriptor.id === 'effort')).toMatchObject({
      settable: false,
      kind: { currentValue: 'max' }
    })
    await act(async () => {
      expect(await hook!.sendWithOutcome('hello')).toBe('accepted')
    })
    expect(fieldsOf(calls()[0]![1]).options).toEqual({ model: 'opus[1m]', effort: 'max' })
  })

  it("sends a command the chat's own agent runs as a message, though Codex's host claims it", async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('accepted') : ok({ models: [], current: {} })
    )
    agent = 'opencode'
    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('/review')).toBe('accepted')
    })
    expect(calls()).toHaveLength(1)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'pending', 'accepted'] as const)(
    'a later Send owns a new id even when the earlier host answer was %s',
    async (state) => {
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.send' ? sendResult(state) : ok({ models: [], current: {} })
      )
      await mountSession()
      await act(async () => {
        const outcome = state === 'unknown' ? 'unknown' : 'accepted'
        expect(await hook!.sendWithOutcome('same text')).toBe(outcome)
        expect(await hook!.sendWithOutcome('same text')).toBe(outcome)
      })
      expect(new Set(sentIds()).size).toBe(2)
    }
  )

  it('shows a recovered unknown once and a new Send and reply without replay', async () => {
    const original = structuredSendResultFixture('unknown')
    if (!('submission' in original)) {
      throw new Error('expected a submission answer')
    }
    original.submission.recovered = true
    const event = snapshotEvent({
      items: [
        {
          itemId: agentJournalSubmissionKey(original.submission.clientMessageId),
          revision: 1,
          sequence: 1,
          observedAt: 10,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'same text' }] }
        }
      ],
      submissions: [original.submission]
    })

    sendRequest.mockImplementation(async (method, params) => {
      if (method !== 'agentSession.send') {
        return ok({ models: [], current: {} })
      }
      const id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
      const value = structuredSendResultFixture('accepted')
      if (!('submission' in value)) {
        throw new Error('expected a submission answer')
      }
      value.clientMessageId = id
      value.submission.clientMessageId = id
      return ok({
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 2 },
        value
      })
    })
    await mountSession()
    act(() => listener?.(event))
    const messages = hook!.session.messages
    expect(messages).toHaveLength(1)
    expect(messages[0]?.unsent).toBeUndefined()
    expect(hook!.isWorking).toBe(false)
    expect(mobileNativeChatUnsentNotices(event.page, agent).size).toBe(0)
    expect(renderer!.root.findByType('span').children).toEqual([])
    await act(async () => {
      expect(await hook!.sendWithOutcome('same text')).toBe('accepted')
    })
    const sent = agentJournalSubmissionKey(sentIds()[0] ?? '')
    expect(hook!.session.messages.map((message) => message.id)).toEqual([messages[0]?.id, sent])
    expect(hook!.session.messages[0]).toEqual(messages[0])
    const followUp = structuredSendResultFixture('accepted')
    if (!('submission' in followUp)) {
      throw new Error('expected a submission answer')
    }
    const newId = sentIds()[0]!
    expect(newId).not.toBe(original.submission.clientMessageId)
    followUp.submission.clientMessageId = newId
    const reply = snapshotEvent({
      items: [
        ...event.page.items,
        { ...event.page.items[0]!, itemId: sent, sequence: 2, observedAt: 20 },
        {
          itemId: 'assistant-reply',
          revision: 1,
          sequence: 3,
          observedAt: 30,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Reply to the new send' }]
          }
        }
      ],
      submissions: [original.submission, followUp.submission]
    })

    act(() => listener?.(reply))
    expect(hook!.session.messages.map((message) => message.id)).toEqual([
      messages[0]?.id,
      sent,
      'assistant-reply'
    ])
    expect(hook!.session.messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'Reply to the new send' }
    ])
    expect(hook!.session.messages[0]).toEqual(messages[0])
    expect(reply.page.submissions[0]).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(calls()).toHaveLength(1)
  })

  it.each(['reply-before-row', 'row-before-commit'] as const)(
    'leaves a recorded rejection to its row, with no banner and nothing handed back, for %s',
    async (order) => {
      const fact = { kind: 'notSignedIn' } as const
      const words = agentSessionFailureWords(fact, { agentName: 'Codex', surface: 'row' })
      const value = structuredSendResultFixture('rejected', words.text)
      if (!('submission' in value)) {
        throw new Error('expected submission')
      }
      value.submission.rejection = fact
      const sentRow = agentJournalSubmissionKey(value.submission.clientMessageId)
      const event = snapshotEvent({
        items: [
          {
            itemId: 'auth-row',
            sequence: 1,
            revision: 1,
            observedAt: 1,
            body: { kind: 'status', tone: 'error', ...words }
          },
          {
            itemId: sentRow,
            sequence: 2,
            revision: 1,
            observedAt: 2,
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'my message' }] }
          }
        ],
        submissions: [value.submission]
      })

      sendRequest.mockImplementation(async (method) => {
        if (method !== 'agentSession.send') {
          return ok({ models: [], current: {} })
        }
        if (order === 'row-before-commit') {
          listener?.(event)
        }
        return ok({
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'epoch-1', sequence: 1 },
          value
        })
      })
      await mountSession()
      await act(async () => {
        expect(await hook!.sendWithOutcome('my message')).toBe('accepted')
      })
      if (order === 'reply-before-row') {
        act(() => listener?.(event))
      }
      expect(onSendError).not.toHaveBeenCalled()
      expect(renderer!.root.findByType('span').children).toEqual([])
      expect(hook!.session.messages.find((message) => message.id === sentRow)).toMatchObject({
        unsent: true
      })
    }
  )

  it('does not replay an old action after remount', async () => {
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.send') {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return ok({ models: [], current: {} })
    })
    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('survive remount')).toBe('unknown')
    })
    act(() => renderer?.unmount())
    renderer = null
    listener = null
    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('survive remount')).toBe('unknown')
    })
    expect(new Set(sentIds()).size).toBe(2)
  })

  it('uses newly uploaded attachment paths for a new action with the same image', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('unknown') : ok({ models: [], current: {} })
    )
    await mountSession()
    await act(async () => {
      for (const path of ['/tmp/original.png', '/tmp/reuploaded.png']) {
        expect(
          await hook!.sendWithOutcome('describe', undefined, undefined, [
            {
              path,
              previewUri: 'file:///photo.jpg'
            }
          ])
        ).toBe('unknown')
      }
    })
    expect(new Set(sentIds()).size).toBe(2)
    expect(calls()[1]?.[1]).toMatchObject({
      body: {
        blocks: expect.arrayContaining([{ type: 'image-ref', path: '/tmp/reuploaded.png' }])
      }
    })
  })

  it.each([true, false])(
    'sends the picked skill path only to a host that takes it: %s',
    async (takesSkills) => {
      hostSupport = structuredAgentSessionHostSupport(
        takesSkills ? [AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY] : []
      )
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.send' ? sendResult('accepted') : ok({ models: [], current: {} })
      )
      await mountSession()
      const review = { name: 'review', path: '/repo/.agents/skills/review/SKILL.md' }
      await act(async () => {
        await hook!.sendWithOutcome('$review this', undefined, undefined, [], [review])
      })
      expect(fieldsOf(calls()[0]?.[1]).body).toEqual({
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review this' }],
        ...(takesSkills ? { skills: [review] } : {})
      })
    }
  )

  it('does not infer omitted captured skills from the live composer draft', async () => {
    hostSupport = structuredAgentSessionHostSupport([AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY])
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('accepted') : ok({ models: [], current: {} })
    )
    updateMobileNativeChatDraftInputs('ordinary-draft', () => ({
      images: [],
      files: [],
      skills: [{ name: 'review', path: '/live/SKILL.md' }]
    }))
    await mountSession()
    await act(async () => {
      await hook!.sendWithOutcome('$review text')
    })
    expect(fieldsOf(calls()[0]?.[1]).body).not.toHaveProperty('skills')
  })

  it('sends an attached file as a reference after the text, and only images as image blocks', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('accepted') : ok({ models: [], current: {} })
    )
    await mountSession()
    await act(async () => {
      await hook!.sendWithOutcome('read these', undefined, undefined, [
        { path: '/tmp/shot.png', previewUri: 'file:///shot.png' },
        { kind: 'file', path: '/store/u1/spec.pdf' }
      ])
    })
    expect(calls()[0]?.[1]).toMatchObject({
      body: {
        blocks: [
          { type: 'text', text: 'read these\n@/store/u1/spec.pdf' },
          { type: 'image-ref', path: '/tmp/shot.png' }
        ]
      }
    })
  })

  it('reports a send stopped before the agent started it without sending it twice', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send'
        ? sendResult('rejected', DISPATCH_REJECTED_CANCELLED)
        : ok({ models: [], current: {} })
    )
    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('stopped')).toBe('accepted')
      expect(await hook!.sendWithOutcome('stopped')).toBe('accepted')
    })
    expect(calls()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(2)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it.each(['invalid_argument', 'unauthorized'])(
    'a later Send is independent after a %s refusal',
    async (code) => {
      let attempts = 0
      sendRequest.mockImplementation(async (method) => {
        if (method !== 'agentSession.send') {
          return ok({ models: [], current: {} })
        }
        return ++attempts === 1
          ? {
              id: 'request-1',
              ok: false as const,
              error: { code, message: 'Message is not authorized' }
            }
          : sendResult('accepted')
      })
      await mountSession()
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('rejected')
        expect(await hook!.sendWithOutcome('again')).toBe('accepted')
      })
      expect(new Set(sentIds()).size).toBe(2)
    }
  )

  it('a new Send goes through after a stale-fence refusal', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return ok({ models: [], current: {} })
      }
      return ++attempts === 1
        ? ok({
            ok: false,
            refusal: {
              code: 'agent_session_checkpoint_stale',
              message: 'Fence moved',
              currentFence: 3
            }
          })
        : sendResult('accepted')
    })
    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('again')).toBe('rejected')
      expect(await hook!.sendWithOutcome('again')).toBe('accepted')
    })
    expect(new Set(sentIds()).size).toBe(2)
  })

  it('sends nothing once the action budget expires', async () => {
    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('never attempted', undefined, 0)).toBe('rejected')
    })
    expect(calls()).toHaveLength(0)
  })
})
