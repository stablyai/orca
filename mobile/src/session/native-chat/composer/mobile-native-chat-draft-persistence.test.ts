import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { AgentJournalSubmission } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  publishPageDeviceStore,
  type PageDeviceStore
} from '../../../mobile-web-shell/bridge/page-device-store'
import {
  decodeDeviceStoreValue,
  encodeDeviceStoreValue
} from '../../../device-store/device-store-value-codec'
import { acceptedSubmission } from '../../use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileStructuredSends } from '../../use-mobile-structured-sends'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  addMobileNativeChatDraftImages,
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import {
  clearMobileNativeChatDraftForSend,
  editMobileNativeChatDraft,
  pruneMobileNativeChatTabDrafts,
  readMobileNativeChatDraftEditGeneration,
  readMobileNativeChatPickedSkills,
  recordMobileNativeChatSkillPick,
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import {
  beginMobileNativeChatInFlightSend,
  settleMobileNativeChatInFlightSend
} from './mobile-native-chat-in-flight-sends'
import { loadMobileNativeChatDrafts } from './mobile-native-chat-draft-persistence'
import {
  queueMobileNativeChatOfflineSend,
  readMobileNativeChatOfflineSends
} from './mobile-native-chat-offline-sends'

const storage = vi.hoisted(() => new Map<string, string>())
// A host-area page reads the key over the bridge, so its load can land after the user acts.
const slowRead = vi.hoisted((): { gate: Promise<void> | null } => ({ gate: null }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      await slowRead.gate
      return storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: async (key: string) => {
      storage.delete(key)
    }
  }
}))

const TAB_A = 'host-1\0wt-1\0tab-a'
const TAB_B = 'host-1\0wt-1\0tab-b'
const LEGACY_KEY = 'orca:terminalDrafts:host-1:wt-1'
const STORE_KEY = 'draft:chat:wt-1:'

// The shell's draft table: what outlives the app on a shell that grants the store.
const draftTable = new Map<string, string>()
const deviceStore: PageDeviceStore = {
  available: () => true,
  read: async (_table, keys) => ({
    status: 'ok',
    values: keys.map((key) => draftTable.get(key) ?? null)
  }),
  write: async (_table, ops) => {
    for (const op of ops) {
      if (op.value === null) {
        draftTable.delete(op.key)
      } else {
        draftTable.set(op.key, op.value)
      }
    }
    return { written: true }
  }
}

function userMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

function storedRow(): unknown {
  const raw = draftTable.get(STORE_KEY)
  return raw === undefined ? null : decodeDeviceStoreValue(raw)
}

// Loads queue behind every earlier read and write of the workspace's key.
function writesSettled(): Promise<void> {
  return loadMobileNativeChatDrafts('host-1', 'wt-1')
}

async function settle(): Promise<void> {
  await vi.runAllTimersAsync()
  await writesSettled()
}

// The page document dies with the app; storage is all that survives.
async function relaunch(): Promise<void> {
  resetMobileNativeChatDraftStoreForTests()
  await loadMobileNativeChatDrafts('host-1', 'wt-1')
}

function draftText(scope: string): string {
  let text = ''
  function Reader(): null {
    text = useMobileNativeChatDraft(scope)
    return null
  }
  let reader: ReturnType<typeof create> | null = null
  act(() => {
    reader = create(createElement(Reader))
  })
  act(() => reader?.unmount())
  return text
}

describe('mobile native-chat draft persistence', () => {
  afterEach(() => {
    resetMobileNativeChatDraftStoreForTests()
    storage.clear()
    draftTable.clear()
    publishPageDeviceStore(null)
    slowRead.gate = null
    vi.useRealTimers()
  })

  it('brings back a draft and its skill picks after a relaunch', async () => {
    vi.useFakeTimers()
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    recordMobileNativeChatSkillPick(TAB_A, { token: '$review', path: '/skills/review/SKILL.md' })
    editMobileNativeChatDraft(TAB_A, '$review the auth change')
    await settle()

    await relaunch()

    expect(draftText(TAB_A)).toBe('$review the auth change')
    expect(readMobileNativeChatPickedSkills(TAB_A)).toEqual([
      { name: 'review', path: '/skills/review/SKILL.md' }
    ])
  })

  it('brings back a message queued offline, paused, after a relaunch', async () => {
    vi.useFakeTimers()
    publishPageDeviceStore(deviceStore)
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    queueMobileNativeChatOfflineSend(TAB_A, {
      text: 'also check the PR tab',
      images: [{ id: 'chip-1', path: '/host/shot.png', previewUri: 'file:///shot.png' }],
      files: [],
      skills: [],
      skillOrigin: null
    })
    await settle()

    await relaunch()

    expect(
      readMobileNativeChatOfflineSends(TAB_A).map(({ text, paused, images }) => ({
        text,
        paused,
        paths: images.map((image) => image.path)
      }))
    ).toEqual([{ text: 'also check the PR tab', paused: 'closed', paths: ['/host/shot.png'] }])
  })

  it('keeps a send made before the saved drafts finished loading', async () => {
    vi.useFakeTimers()
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    editMobileNativeChatDraft(TAB_A, 'old draft')
    await settle()
    resetMobileNativeChatDraftStoreForTests()
    let release = (): void => {}
    slowRead.gate = new Promise((resolve) => {
      release = resolve
    })
    const loading = loadMobileNativeChatDrafts('host-1', 'wt-1')

    editMobileNativeChatDraft(TAB_A, 'sent before load')
    clearMobileNativeChatDraftForSend(
      TAB_A,
      readMobileNativeChatDraftEditGeneration(TAB_A),
      'sent before load'
    )
    slowRead.gate = null
    release()
    await loading
    await writesSettled()

    expect(draftText(TAB_A)).toBe('')
    await relaunch()
    expect(draftText(TAB_A)).toBe('')
  })

  it('drops saved drafts of tabs the host no longer lists', async () => {
    vi.useFakeTimers()
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    editMobileNativeChatDraft(TAB_A, 'keep me')
    editMobileNativeChatDraft(TAB_B, 'closed elsewhere')
    await settle()
    await relaunch()

    pruneMobileNativeChatTabDrafts('host-1', 'wt-1', ['tab-a'])
    await writesSettled()
    await relaunch()

    expect(draftText(TAB_A)).toBe('keep me')
    expect(draftText(TAB_B)).toBe('')
  })

  it('moves the old slot into the device store, keeping the store copy of a tab in both', async () => {
    storage.set(
      LEGACY_KEY,
      JSON.stringify({
        chatDrafts: {
          'tab-a': { text: 'older a', skills: [] },
          'tab-b': { text: 'only in the old slot', skills: [] }
        }
      })
    )
    draftTable.set(
      STORE_KEY,
      encodeDeviceStoreValue({ chatDrafts: { 'tab-a': { text: 'newer a', skills: [] } } })
    )
    publishPageDeviceStore(deviceStore)

    await loadMobileNativeChatDrafts('host-1', 'wt-1')

    expect(draftText(TAB_A)).toBe('newer a')
    expect(draftText(TAB_B)).toBe('only in the old slot')
    expect(storage.has(LEGACY_KEY)).toBe(false)
    await relaunch()
    expect(draftText(TAB_A)).toBe('newer a')
    expect(draftText(TAB_B)).toBe('only in the old slot')
  })

  it("brings back a draft's attachment chips after a relaunch", async () => {
    vi.useFakeTimers()
    publishPageDeviceStore(deviceStore)
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    editMobileNativeChatDraft(TAB_A, 'what is in these?')
    addMobileNativeChatDraftImages(mobileNativeChatDraftDestination(TAB_A), [
      { path: '/tmp/orca/shot.png', previewUri: 'data:image/png;base64,AAAA' }
    ])
    updateMobileNativeChatDraftInputs(TAB_A, (inputs) => ({
      ...inputs,
      files: [
        {
          id: 'f1',
          name: 'notes.md',
          mime: 'text/markdown',
          byteLength: 12,
          path: '/tmp/orca/notes.md'
        },
        { id: 'f2', name: 'big.zip', mime: 'application/zip', byteLength: 9, path: null }
      ]
    }))
    await settle()

    await relaunch()

    expect(draftText(TAB_A)).toBe('what is in these?')
    const inputs = readMobileNativeChatDraftInputs(TAB_A)
    expect(inputs.images.map(({ path, previewUri }) => ({ path, previewUri }))).toEqual([
      { path: '/tmp/orca/shot.png', previewUri: '' }
    ])
    expect(inputs.files.map(({ name, path }) => ({ name, path }))).toEqual([
      { name: 'notes.md', path: '/tmp/orca/notes.md' }
    ])
  })

  it('brings back an attachment with no text after a relaunch', async () => {
    vi.useFakeTimers()
    publishPageDeviceStore(deviceStore)
    await loadMobileNativeChatDrafts('host-1', 'wt-1')
    addMobileNativeChatDraftImages(mobileNativeChatDraftDestination(TAB_A), [
      { path: '/tmp/orca/only.png', previewUri: 'data:image/png;base64,AAAA' }
    ])
    await settle()

    await relaunch()

    expect(readMobileNativeChatDraftInputs(TAB_A).images.map(({ path }) => path)).toEqual([
      '/tmp/orca/only.png'
    ])
  })

  describe('a send cut off by a kill', () => {
    let renderer: ReactTestRenderer | null = null
    let drafts: ReturnType<typeof useMobileNativeChatDrafts> | null = null
    const onSendError = vi.fn()

    afterEach(() => {
      act(() => renderer?.unmount())
      renderer = null
      drafts = null
      onSendError.mockReset()
    })

    function TerminalChat({ messages }: { messages: NativeChatMessage[] }): null {
      drafts = useMobileNativeChatDrafts({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        tabId: 'tab-a',
        sessionId: 'session-a',
        messages,
        transcriptSettled: true,
        onSendError
      })
      return null
    }

    function StructuredChat({ submissions }: { submissions: AgentJournalSubmission[] }): null {
      useMobileStructuredSends({
        sessionKey: 'chat-a',
        sessionId: 'session-a',
        submissions,
        queuedMessages: null,
        onSendError
      })
      return null
    }

    async function mount(element: ReturnType<typeof createElement>): Promise<void> {
      await act(async () => {
        renderer = create(element)
      })
      await act(async () => {
        await loadMobileNativeChatDrafts('host-1', 'wt-1')
      })
    }

    // The page sends and dies before the outcome comes back: only the clearing write reached the store.
    async function sendThenKill(
      text: string,
      kind: 'terminal' | 'structured',
      messages: NativeChatMessage[] = []
    ): Promise<string> {
      await mount(createElement(TerminalChat, { messages }))
      act(() => drafts?.setComposerText(text))
      const origin = drafts?.captureSendOrigin(text)
      if (!origin) {
        throw new Error('the chat has no send origin')
      }
      const id = beginAfterClear(origin, text, kind)
      await settle()
      act(() => renderer?.unmount())
      resetMobileNativeChatDraftStoreForTests()
      return id
    }

    function beginAfterClear(
      origin: NonNullable<ReturnType<NonNullable<typeof drafts>['captureSendOrigin']>>,
      text: string,
      kind: 'terminal' | 'structured',
      clientMessageId?: string
    ): string {
      drafts?.clearDraftForSend(origin, text)
      const id = beginMobileNativeChatInFlightSend(origin, kind, text, { clientMessageId })
      if (!id) {
        throw new Error('the send was not saved')
      }
      return id
    }

    it('hands an unconfirmed terminal-chat send back to the box after the reopen', async () => {
      vi.useFakeTimers()
      publishPageDeviceStore(deviceStore)
      await sendThenKill('ship it', 'terminal')

      await mount(createElement(TerminalChat, { messages: [] }))
      expect(draftText(TAB_A)).toBe('')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })

      expect(draftText(TAB_A)).toBe('ship it')
      expect(onSendError).toHaveBeenCalledWith('Not confirmed. Restored to the box.')
    })

    it('keeps a terminal-chat send the transcript shows, without restoring it', async () => {
      vi.useFakeTimers()
      publishPageDeviceStore(deviceStore)
      await sendThenKill('ship it', 'terminal')

      await mount(
        createElement(TerminalChat, {
          messages: [
            {
              id: 'u1',
              role: 'user',
              blocks: [{ type: 'text', text: 'ship it' }],
              timestamp: null,
              source: 'transcript'
            }
          ]
        })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })

      expect(draftText(TAB_A)).toBe('')
      expect(storedRow()).toBeNull()
    })

    it('keeps a terminal-chat send whose tail scrolled out of the reopened window', async () => {
      vi.useFakeTimers()
      publishPageDeviceStore(deviceStore)
      await sendThenKill('ship it', 'terminal', [userMessage('old', 'earlier question')])

      await mount(createElement(TerminalChat, { messages: [userMessage('u1', 'ship it')] }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })

      expect(draftText(TAB_A)).toBe('')
      expect(onSendError).not.toHaveBeenCalled()
    })

    it('restores a structured send the journal never recorded, and not one it did', async () => {
      vi.useFakeTimers()
      publishPageDeviceStore(deviceStore)
      await mount(createElement(TerminalChat, { messages: [] }))
      for (const [text, clientMessageId] of [
        ['landed', 'm-landed'],
        ['lost', 'm-lost']
      ]) {
        act(() => drafts?.setComposerText(text))
        const origin = drafts?.captureSendOrigin(text)
        if (!origin) {
          throw new Error('the chat has no send origin')
        }
        beginAfterClear(origin, text, 'structured', clientMessageId)
      }
      await settle()
      act(() => renderer?.unmount())
      resetMobileNativeChatDraftStoreForTests()

      await mount(createElement(StructuredChat, { submissions: [acceptedSubmission('m-landed')] }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })

      expect(draftText(TAB_A)).toBe('lost')
      expect(onSendError).toHaveBeenCalledTimes(1)
    })

    it('does not bring back the chips of a sent message after a kill', async () => {
      vi.useFakeTimers()
      publishPageDeviceStore(deviceStore)
      await mount(createElement(TerminalChat, { messages: [] }))
      addMobileNativeChatDraftImages(mobileNativeChatDraftDestination(TAB_A), [
        { path: '/tmp/orca/sent.png', previewUri: 'data:image/png;base64,AAAA' }
      ])
      act(() => drafts?.setComposerText('look'))
      const origin = drafts?.captureSendOrigin('look')
      if (!origin) {
        throw new Error('the chat has no send origin')
      }
      drafts?.clearDraftForSend(origin, 'look')
      const id = beginMobileNativeChatInFlightSend(origin, 'terminal', 'look', {
        intent: { carried: { images: readMobileNativeChatDraftInputs(TAB_A).images, files: [] } }
      })
      settleMobileNativeChatInFlightSend(id, 'sent')
      await settle()
      act(() => renderer?.unmount())

      await relaunch()

      expect(readMobileNativeChatDraftInputs(TAB_A).images).toEqual([])
      expect(storedRow()).toBeNull()
    })

    it('waits out a disconnect before handing a send back', async () => {
      vi.useFakeTimers()
      publishPageDeviceStore(deviceStore)
      await sendThenKill('ship it', 'terminal')

      function OfflineChat(): null {
        useMobileNativeChatDrafts({
          hostId: 'host-1',
          worktreeId: 'wt-1',
          tabId: 'tab-a',
          sessionId: 'session-a',
          messages: [],
          transcriptSettled: true,
          connected: false,
          onSendError
        })
        return null
      }
      await mount(createElement(OfflineChat))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(draftText(TAB_A)).toBe('')
      expect(onSendError).not.toHaveBeenCalled()
    })
  })
})
