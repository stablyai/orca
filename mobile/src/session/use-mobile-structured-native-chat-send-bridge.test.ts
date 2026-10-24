import { copyMobileQueuedMessageToDraft } from './mobile-native-chat-queued-extraction'
import {
  editMobileNativeChatDraft,
  readMobileNativeChatDraft,
  persistMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests,
  hydrateMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileStructuredSendWithOutcome } from './use-mobile-structured-send-with-outcome'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'

const ORIGIN: MobileNativeChatSendOrigin = {
  draftKey: 'draft',
  draftEditGeneration: 0,
  pendingKey: 'pending',
  normalizedText: 'command',
  baselineOccurrences: 0,
  baselineTailMessageId: null,
  baselineResolved: true,
  sentAt: 0
}

describe('useMobileStructuredNativeChatSendBridge', () => {
  let renderer: ReactTestRenderer | null = null
  let sendWithOutcome: (text: string) => Promise<MobileNativeChatSendOutcome>
  const captureSendOrigin = vi.fn(() => ORIGIN)
  const clearDraftForSend = vi.fn()
  const onSendError = vi.fn()
  const restoreRejectedDraft = vi.fn()
  const sendStructured = vi.fn()

  const skills = [{ name: 'review', path: '/skills/review' }]
  function Harness({ agent }: { agent: StructuredAgentId }): null {
    sendWithOutcome = useMobileStructuredNativeChatSendBridge({
      agent,
      captureSendOrigin,
      clearDraftForSend,
      onSendError,
      restoreRejectedDraft,
      sendStructured
    }).sendWithOutcome
    return null
  }

  function mount(agent: StructuredAgentId): void {
    act(() => {
      renderer = create(createElement(Harness, { agent }))
    })
  }

  beforeEach(() => {
    captureSendOrigin.mockImplementation(() => ORIGIN)
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    resetMobileNativeChatDraftStoreForTests()
    publishMobileChatDraftStorage(null)
  })

  // The structured session draws, or holds, what the host took; the composer stays cleared.
  it.each(['accepted', 'unknown', 'queued'] as const)(
    'leaves a %s send of a command the active agent owns to the structured session',
    async (outcome) => {
      sendStructured.mockResolvedValue(outcome)
      mount('claude')

      await expect(sendWithOutcome('/review')).resolves.toBe(outcome)

      expect(sendStructured).toHaveBeenCalledWith('/review')
      expect(restoreRejectedDraft).not.toHaveBeenCalled()
    }
  )

  it('keeps host-command reconciliation for Codex', async () => {
    sendStructured.mockResolvedValue('unknown')
    mount('codex')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, '/review')
  })

  it("reads another agent's sends by that agent's commands, never Codex's", async () => {
    sendStructured.mockResolvedValue('unknown')
    mount('grok')

    await expect(sendWithOutcome('/review')).resolves.toBe('unknown')

    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('puts a refused send back in the composer', async () => {
    sendStructured.mockResolvedValue('rejected')
    mount('claude')

    await expect(sendWithOutcome('hello')).resolves.toBe('rejected')

    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, 'hello')
  })
  it('captures persisted picked skills before the ordinary draft is cleared', async () => {
    publishMobileChatDraftStorage({
      read: async () => null,
      write: async () => {},
      removeWorkspace: async () => {}
    })
    await copyMobileQueuedMessageToDraft('draft', {
      messageId: 'picked',
      position: 1,
      state: 'waiting',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '$review' }], skills }
    })
    clearDraftForSend.mockImplementationOnce(() => editMobileNativeChatDraft('draft', ''))
    sendStructured.mockResolvedValue('accepted')
    captureSendOrigin.mockReturnValue({
      ...ORIGIN,
      skills: readMobileNativeChatDraft('draft').skills
    })
    mount('codex')
    await expect(sendWithOutcome('$review')).resolves.toBe('accepted')
    expect(sendStructured).toHaveBeenCalledWith('$review', undefined, undefined, undefined, skills)
  })
  it('rejects a 17-file extracted draft before clearing and retains text, images and skills on disk', async () => {
    const scope = 'draft'
    const disk = new Map<string, string>()
    publishMobileChatDraftStorage({
      read: async (key) => disk.get(key) ?? null,
      write: async (key, value) => {
        if (value === null) {
          disk.delete(key)
        } else {
          disk.set(key, value)
        }
      },
      removeWorkspace: async () => {}
    })
    for (const [index, count] of [9, 8].entries()) {
      const refs = Array.from({ length: count }, (_, at) => ({
        name: `skill${index}-${at}`,
        path: `/${index}/${at}`
      }))
      await copyMobileQueuedMessageToDraft(scope, {
        messageId: `queued-${index}`,
        position: index,
        state: 'waiting',
        body: {
          kind: 'message',
          role: 'user',
          skills: refs,
          blocks: [
            { type: 'text', text: refs.map(({ name }) => `$${name}`).join(' ') },
            { type: 'image-ref', url: `https://example.com/${index}.png` }
          ]
        }
      })
    }
    editMobileNativeChatDraft(scope, (text) => `edited ${text}`)
    const captured = readMobileNativeChatDraft(scope)
    clearDraftForSend.mockImplementation(() => editMobileNativeChatDraft(scope, ''))
    captureSendOrigin.mockReturnValue({ ...ORIGIN, skills: captured.skills })
    mount('codex')
    await expect(sendWithOutcome(captured.text)).resolves.toBe('rejected')
    expect(clearDraftForSend).not.toHaveBeenCalled()
    expect(sendStructured).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith(
      'Your message was not sent to Codex. Keep at most 16 selected skill files and try again.'
    )
    await persistMobileNativeChatDraft(scope)
    resetMobileNativeChatDraftStoreForTests()
    await hydrateMobileNativeChatDraft(scope)
    expect(readMobileNativeChatDraft(scope)).toMatchObject({
      text: captured.text,
      images: captured.images,
      skills: captured.skills
    })
  })
})

it.each(['rejected', 'unknown'] as const)(
  'recovers a captured %s Send through the real owner, bridge and wire builder',
  async (outcome) => {
    const scope = 'host\0workspace\0tab'
    const selected = { name: 'review', path: '/a/review/SKILL.md' }
    const newer = { name: 'review', path: '/b/review/SKILL.md' }
    let blockSaves = false
    let releaseSaves = () => {}
    const saveWait = new Promise<void>((resolve) => {
      releaseSaves = resolve
    })
    const client = createFakeRpcClient()
    const onSendError = vi.fn()
    const messages: NativeChatMessage[] = []
    const stateRef = { current: { ...EMPTY_STRUCTURED_AGENT_SESSION, fence: 1 } }
    let renderer: ReactTestRenderer | undefined
    let api: ReturnType<typeof useMobileNativeChatDrafts> &
      ReturnType<typeof useMobileStructuredNativeChatSendBridge>
    function Harness() {
      const drafts = useMobileNativeChatDrafts({
        hostId: 'host',
        worktreeId: 'workspace',
        tabId: 'tab',
        sessionId: 'session',
        messages,
        transcriptSettled: true
      })
      const sendStructured = useMobileStructuredSendWithOutcome({
        agent: 'codex',
        client,
        sessionId: 'session',
        enabled: true,
        queueCapable: false,
        commandsWait: false,
        stateRef,
        stopping: false,
        accept: vi.fn(),
        hold: vi.fn(),
        commandPending: { current: false },
        controller: {
          snapshot: [],
          setOption: async () => false,
          invokeAction: async () => false,
          conversationCommands: ['compact']
        },
        onSendError
      })
      api = {
        ...drafts,
        ...useMobileStructuredNativeChatSendBridge({
          agent: 'codex',
          ...drafts,
          authoringReady: drafts.draftAuthoringReady,
          sendStructured,
          onSendError
        })
      }
      return null
    }
    publishMobileChatDraftStorage({
      read: async () => null,
      write: async () => {
        if (blockSaves) {
          await saveWait
        }
      },
      removeWorkspace: async () => {}
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
      const original = outcome === 'rejected' ? '$review' : '/compact'
      await act(async () => {
        if (outcome === 'rejected') {
          await copyMobileQueuedMessageToDraft(scope, {
            messageId: 'original',
            position: 1,
            state: 'waiting',
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: original }],
              skills: [selected]
            }
          })
        } else {
          api.setComposerText(original)
        }
      })
      let pending: Promise<MobileNativeChatSendOutcome>
      await act(async () => {
        pending = api.sendWithOutcome(original)
        await Promise.resolve()
      })
      expect(readMobileNativeChatDraft(scope).text).toBe('')
      expect(readMobileNativeChatDraft(scope).skills).toBeUndefined()
      expect(client.requests[0]?.method).toBe(
        outcome === 'rejected' ? 'agentSession.send' : 'agentSession.conversationCommand'
      )
      if (outcome === 'rejected') {
        expect(client.requests[0]?.args[1]).toMatchObject({
          body: { skills: [selected] }
        })
      }
      await act(async () => {
        publishMobileChatDraftStorage(null)
        for (let replacement = 0; replacement < 3; replacement++) {
          publishMobileChatDraftStorage({
            read: async () => null,
            write: async () => {
              if (blockSaves) {
                await saveWait
              }
            },
            removeWorkspace: async () => {}
          })
        }
        api.setComposerText(outcome === 'rejected' ? '' : 'newer')
        await copyMobileQueuedMessageToDraft(scope, {
          messageId: 'newer',
          position: 2,
          state: 'waiting',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: '$review' }],
            skills: [newer]
          }
        })
      })
      blockSaves = true
      await act(async () => {
        client.requests[0]!.resolve(
          rpcSuccess(
            'first',
            outcome === 'unknown'
              ? { ok: true, value: { state: 'unknown' } }
              : {
                  ok: false,
                  refusal: {
                    code: 'agent_session_operation_invalid',
                    details: { reason: 'turnActive' },
                    message: 'definite refusal'
                  }
                }
          )
        )
        expect(await pending!).toBe(outcome)
      })
      const restored = readMobileNativeChatDraft(scope)
      expect(restored.text).toBe(
        `${outcome === 'rejected' ? '' : 'newer\n\n'}$review\n\n${original}`
      )
      const refs = outcome === 'rejected' ? [newer, selected] : [newer]
      expect(restored.skills).toEqual(refs)
      let retry: Promise<MobileNativeChatSendOutcome>
      await act(async () => {
        retry = api.sendWithOutcome(restored.text)
        await Promise.resolve()
      })
      expect(client.requests[1]?.method).toBe('agentSession.send')
      expect(client.requests[1]?.args[1]).toMatchObject({ body: { skills: refs } })
      await act(async () => {
        client.requests[1]!.resolve(
          rpcSuccess('retry', {
            ok: false,
            refusal: {
              code: 'agent_session_operation_invalid',
              details: { reason: 'turnActive' },
              message: 'definite refusal'
            }
          })
        )
        expect(await retry!).toBe('rejected')
      })
    } finally {
      releaseSaves()
      act(() => renderer?.unmount())
      resetMobileNativeChatDraftStoreForTests()
      publishMobileChatDraftStorage(null)
    }
  }
)
