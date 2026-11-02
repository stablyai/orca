import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { mobileQueuedMessageCards } from './mobile-structured-queued-message-cards'
import { queuedDraft } from './use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileStructuredQueuedEdit } from './use-mobile-structured-queued-edit'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import { useMobileNativeChatFileAttachments } from './native-chat/composer/use-mobile-native-chat-file-attachments'
import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  mobileNativeChatLaunchDraftSeeds,
  readMobileNativeChatDraftEditGeneration,
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './native-chat/composer/mobile-native-chat-draft-store'
import { useMobileNativeChatDrafts } from './native-chat/composer/use-mobile-native-chat-drafts'

const picker = vi.hoisted(() => ({ pickFiles: vi.fn(), pickImages: vi.fn() }))
vi.mock('../platform/media-picker', () => ({ useMediaPicker: () => picker }))

const target = 'host\0folder:workspace\0original'
let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  resetMobileNativeChatDraftStoreForTests()
})

async function mount(holdSave = false) {
  const message = queuedDraft({ messageId: 'queued' })
  const cards = mobileQueuedMessageCards([message], [], { agentWorking: true })
  let finishUpload = () => {}
  let uploadStarted = () => {}
  const uploadOpen = new Promise<void>((resolve) => {
    uploadStarted = resolve
  })
  const uploadGate = new Promise<void>((resolve) => {
    finishUpload = resolve
  })
  let finishSave = () => {}
  const saveGate = new Promise<void>((resolve) => {
    finishSave = resolve
  })
  let uploadStarts = 0
  picker.pickFiles.mockImplementation(async function* () {
    for (const name of ['a.txt', 'b.txt']) {
      yield { name, mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
    }
  })
  const client = stubRpcClient({
    sendRequest: async (method, params) => {
      if (method.endsWith('uploadStart')) {
        uploadStarts += 1
        uploadStarted()
        await uploadGate
        return { id: 'upload', ok: true, result: { uploadId: `upload-${uploadStarts}` } }
      }
      if (method.endsWith('uploadCommit')) {
        return {
          id: 'commit',
          ok: true,
          result: { path: `/stored/${uploadStarts}.txt`, name: 'a.txt', byteLength: 1 }
        }
      }
      if (method === 'agentSession.queuedMessageEditHold') {
        const released =
          params && typeof params === 'object' && 'action' in params && params.action === 'release'
        return {
          id: 'hold',
          ok: true,
          result: released
            ? { status: 'released' }
            : { status: 'held', fingerprint: 'fp', leaseDurationMs: 120_000, remainingMs: 120_000 }
        }
      }
      return { id: 'ok', ok: true, result: { closed: true, retirementConfirmed: true } }
    }
  })
  let edit: ReturnType<typeof useMobileStructuredQueuedEdit> | undefined
  let drafts: ReturnType<typeof useMobileNativeChatDrafts> | undefined
  let originalText = ''
  let close: (() => Promise<void>) | undefined
  let navigate: (() => void) | undefined
  let attach: (() => Promise<void>) | undefined
  function Upload({ scopeKey }: { scopeKey: string }) {
    const files = useMobileNativeChatFileAttachments({
      client,
      sessionId: 'session',
      scopeKey,
      enabled: true,
      showToast: vi.fn()
    })
    attach = files.attachFiles
    return null
  }
  function Harness() {
    const [tab, setTab] = useState<string | null>('original')
    drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'folder:workspace',
      tabId: tab,
      sessionId: 'session',
      messages: [],
      launchDraft: 'launch context',
      chatActive: tab !== null,
      transcriptLoading: false,
      transcriptSettled: true
    })
    originalText = useMobileNativeChatDraft(target)
    edit = useMobileStructuredQueuedEdit({
      client,
      sessionId: 'session',
      sessionKey: tab ?? 'closed',
      composerScopeKey: tab ? `host\0folder:workspace\0${tab}` : null,
      chatActive: tab !== null,
      enabled: true,
      imagesCapable: true,
      messages: [message],
      cards,
      appendComposerText: undefined,
      mutate: async () => {
        if (holdSave) {
          await saveGate
        }
        return { status: 'rejected' }
      },
      onSendError: vi.fn()
    })
    const scope = {
      hostId: 'host',
      worktreeId: 'folder:workspace',
      client,
      setSessionTabs: vi.fn(),
      setFileDocs: vi.fn(),
      setMarkdownDocs: vi.fn(),
      sessionTabsRef: { current: [] },
      reconcileBufferedDraftsRef: { current: vi.fn() },
      closedTabTombstonesRef: { current: new Map() },
      clearTerminalLiveInputDefault: vi.fn(),
      setActiveHandle: vi.fn(),
      setActiveSessionTabId: setTab,
      activeSessionTabIdRef: { current: tab },
      selectedSessionTabIdRef: { current: tab },
      renameTarget: null,
      setRenameTarget: vi.fn(),
      terminalRefs: { current: new Map() },
      activeHandleRef: { current: null },
      activeSessionTabTypeRef: { current: 'agent-session' },
      pendingSelectionRef: { current: null },
      pendingBrowserFocusPageIdRef: { current: null },
      scheduleDelayedAction: vi.fn(),
      unsubscribeTerminal: vi.fn(),
      subscribeToTerminal: vi.fn(),
      fetchTerminals: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness supplies every member the confirmed tab-close branch reads; unrelated terminal actions are unused.
    const actions = useMobileSessionCloseActions(scope as never)
    close = () =>
      actions.handleCloseSessionTab({
        type: 'agent-session',
        id: 'original',
        title: 'Original',
        sessionId: 'session',
        agent: 'codex',
        isActive: true
      })
    navigate = () => setTab('other')
    return edit.editor ? createElement(Upload, { scopeKey: edit.editor.scopeKey }) : null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  function read() {
    if (!edit || !close || !navigate || !drafts) {
      throw new Error('queued editor did not mount')
    }
    return { edit, close, navigate, drafts, originalText }
  }
  await act(async () => {
    expect(await read().edit.begin('queued')).toBe(true)
  })
  const scope = read().edit.editor?.scopeKey
  if (!scope) {
    throw new Error('queued editor did not open')
  }
  const destination = mobileNativeChatDraftDestination(scope)
  act(() => {
    read().edit.editor?.change('changed')
    updateMobileNativeChatDraftInputs(scope, (current) => ({
      ...current,
      images: [{ id: 'added', path: '/new.png', previewUri: 'data:image/png;base64,YQ==' }]
    }))
  })
  return {
    read,
    scope,
    destination,
    finishSave,
    async startUpload() {
      if (!attach) {
        throw new Error('upload composer did not mount')
      }
      let work: Promise<void> | undefined
      await act(async () => {
        work = attach?.()
        await uploadOpen
      })
      return {
        async finish() {
          await act(async () => {
            finishUpload()
            await work
          })
        }
      }
    },
    uploadStarts: () => uploadStarts
  }
}

it('does not resurrect a tab closed before React hands back its editor or uploads finish', async () => {
  const queued = await mount()
  const upload = await queued.startUpload()
  await act(async () => queued.read().close())
  expect(readMobileNativeChatDraftInputs(target).images).toHaveLength(0)
  expect(readMobileNativeChatDraftInputs(target).files).toHaveLength(0)
  expect(queued.destination.active).toBe(false)
  await upload.finish()
  expect(queued.uploadStarts()).toBe(1)
  expect(readMobileNativeChatDraftInputs(target).files).toHaveLength(0)
  expect(readMobileNativeChatDraftInputs(queued.scope).files).toHaveLength(0)
})

it('hands input and pending uploads back to the original live tab during navigation', async () => {
  const queued = await mount()
  const upload = await queued.startUpload()
  await act(async () => queued.read().navigate())
  expect(readMobileNativeChatDraftInputs(target).images).toHaveLength(1)
  expect(queued.destination.active).toBe(true)
  expect(queued.destination.scope).toBe(target)
  await upload.finish()
  expect(queued.uploadStarts()).toBe(2)
  expect(readMobileNativeChatDraftInputs(target).files).toHaveLength(2)
})

it('keeps a pending save from restoring input after its original tab closes', async () => {
  const queued = await mount(true)
  let saving: Promise<boolean> | undefined
  await act(async () => {
    saving = queued.read().edit.editor?.save()
  })
  await act(async () => queued.read().close())
  await act(async () => {
    queued.finishSave()
    await saving
  })
  expect(readMobileNativeChatDraftInputs(target).images).toHaveLength(0)
  expect(readMobileNativeChatDraftInputs(queued.scope).images).toHaveLength(0)
  expect(queued.destination.active).toBe(false)
})

it('does not let a rejected old send restore closed-tab text, revision or launch seed', async () => {
  const queued = await mount()
  const original = queued.read().drafts
  expect(queued.read().originalText).toBe('launch context')
  await act(async () => original.setComposerText('typed draft'))
  const origin = original.captureSendOrigin('typed draft')
  if (!origin) {
    throw new Error('original draft had no send origin')
  }
  await act(async () => original.clearDraftForSend(origin, 'typed draft'))
  let rejectSend = () => {}
  const rejected = new Promise<void>((resolve) => {
    rejectSend = resolve
  }).then(() => {
    original.restoreRejectedDraft(origin, 'typed draft')
  })
  await act(async () => queued.read().close())
  expect(queued.read().originalText).toBe('')
  expect(readMobileNativeChatDraftEditGeneration(target)).toBe(0)
  expect(mobileNativeChatLaunchDraftSeeds.has(target)).toBe(false)
  await act(async () => {
    rejectSend()
    await rejected
  })
  expect(queued.read().originalText).toBe('')
  expect(readMobileNativeChatDraftEditGeneration(target)).toBe(0)
  expect(mobileNativeChatLaunchDraftSeeds.has(target)).toBe(false)
})
