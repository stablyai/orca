import type { NativeChatSkillDiscoverySnapshot } from '../../../src/shared/native-chat/input/native-chat-picker-items'
import type { QueuedEditHostFixtureModule } from '../../../src/shared/queued-edit-host.test-fixture'
import type { AcpCommandOptionsFixtureModule } from '../../../src/shared/mobile-queued-edit-host.test-fixture-contract'
import { QueuedMessageUpdateParams } from '../../../src/shared/rpc-contract/structured-agent-session-queued-edit-params'
import { mobileQueuedEditHarness, readOrHoldReply } from './mobile-queued-edit-hook.test-fixture'
import { createElement, type ReactNode } from 'react'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ScrollView, TextInput } from 'react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import { MobileNativeChatQueuedMessages } from './native-chat/input/MobileNativeChatQueuedMessages'
import {
  MobileNativeChatComposer,
  MobileNativeChatDraftComposer
} from './native-chat/composer/MobileNativeChatComposer'
import { MobileNativeChatComposerMenu } from './native-chat/composer/MobileNativeChatComposerMenu'
import { MobileQueuedMessageComposer } from './MobileQueuedMessageComposer'
import { useMobileNativeChatDrafts } from './native-chat/composer/use-mobile-native-chat-drafts'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import { mobileNativeChatScopeKey } from './native-chat/mobile-native-chat-scope-key'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import { useMobileNativeChatFileAttachments } from './native-chat/composer/use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageAttachments } from './native-chat/composer/use-mobile-native-chat-image-attachments'
import {
  useMobileNativeChatDraft,
  setMobileNativeChatDraftText
} from './native-chat/composer/mobile-native-chat-draft-store'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  queuedDraft,
  SESSION_ID,
  mutationOk
} from './use-mobile-structured-agent-session-queued.test-fixture'

const picker = vi.hoisted(() => ({ pickFiles: vi.fn(), pickImages: vi.fn() }))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('../platform/media-picker', () => ({ useMediaPicker: () => picker }))
vi.mock('../components/DragReorderList', () => ({ DragReorderList: 'DragReorderList' }))
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { ScrollView: 'ScrollView' },
    useAnimatedRef: () => useRef(null),
    useSharedValue: (value: unknown) => useRef({ value }).current
  }
})
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'BottomDrawer' }))
vi.mock('../components/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))

const { queuedEditHost } = await vi.importActual<QueuedEditHostFixtureModule>(
  '../../../src/main/native-chat/agent-session-journal/queued-edit-host.test-fixture'
)
const { AcpStructuredOptions } = await vi.importActual<AcpCommandOptionsFixtureModule>(
  '../../../src/main/acp/acp-structured-options'
)

describe('phone inline editor presentation', () => {
  const { state, Harness, mount, sendRequest, error, resolved, client } = mobileQueuedEditHarness()
  async function rows(
    message: Parameters<typeof mount>[0],
    agent = 'codex',
    sessionId = SESSION_ID,
    catalog: {
      reported: { name: string; kind: 'skill' | 'command'; path?: string }[]
      discovery?: NativeChatSkillDiscoverySnapshot
    } = {
      reported: []
    },
    extra?: (hook: NonNullable<typeof state.hook>) => ReactNode,
    composerScopeKey = 'original-bottom'
  ) {
    await mount(message, true, agent, sessionId)
    act(() => state.hook!.queued.editor!.cancel())
    resolved.mockClear()
    const renderContent: NonNullable<Parameters<typeof Harness>[0]['renderContent']> = (hook) =>
      createElement(
        MobileQueuedMessageComposerContext.Provider,
        {
          value: {
            agent,
            structured: {
              catalog: { reported: catalog.reported, conversationCommands: [] },
              onSlashMenuOpen: () => {},
              files: [],
              onRemoveFile: () => {}
            },
            skillDiscovery: catalog.discovery,
            filePaths: [],
            onNeedFiles: undefined,
            onError: error,
            onMicPress: undefined,
            micActive: false,
            micStarting: false,
            micProcessing: false,
            dictationMode: undefined,
            onMicPressIn: () => {},
            onMicPressOut: () => {}
          }
        },
        createElement(MobileNativeChatQueuedMessages, {
          cards: hook.queued.cards,
          onEdit: hook.queued.edit,
          editor: hook.queued.editor
        }),
        extra?.(hook)
      )
    const rerender = async () =>
      act(async () =>
        state.renderer!.update(
          createElement(Harness, {
            sessionId,
            agent,
            renderContent,
            skillsSupport: true,
            imagesSupport: true,
            composerScopeKey
          })
        )
      )
    await rerender()
    const root = () => state.renderer!.root
    const button = (label: string) =>
      root().findAll(
        (node) =>
          node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
      )[0]!
    const field = () =>
      root()
        .findByType(MobileQueuedMessageComposer)
        .find((node) => node.type === TextInput && node.props.multiline === true)
    const open = async () => {
      await act(async () => button('More actions').props.onPress())
      const sheet = root().find(
        (node) =>
          node.type === ActionSheetModal && node.props.actions?.[0]?.label === 'Edit message'
      )
      await act(async () => sheet.props.actions[0].onPress())
      expect(root().findAllByType(MobileQueuedMessageComposer)).toHaveLength(1)
      expect(root().findAllByType(MobileNativeChatComposer)).toHaveLength(extra ? 2 : 1)
    }
    await open()
    return { root, button, field, rerender, open }
  }
  it('gives the short image editor and open picker the available queue scroll space, separate from the ordinary draft', async () => {
    const message = queuedDraft({
      messageId: 'photo-layout',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'short edit' },
          { type: 'image-ref', url: 'https://host/photo.png', alt: 'photo' }
        ]
      }
    })
    const catalog = {
      reported: Array.from({ length: 6 }, (_, i) => ({
        name: `skill-${i}`,
        kind: 'skill' as const,
        path: `/skills/${i}/SKILL.md`
      }))
    }
    const { root, button } = await rows(message, 'codex', SESSION_ID, catalog, () =>
      createElement(MobileNativeChatDraftComposer, {
        draftKey: 'original-bottom',
        draftScopeKey: 'original-bottom',
        agent: 'codex',
        structured: {
          catalog: { ...catalog, conversationCommands: [] },
          onSlashMenuOpen: () => {},
          files: [],
          onRemoveFile: () => {}
        },
        onChangeText: (text) => setMobileNativeChatDraftText('original-bottom', text),
        onSend: async () => true,
        sendSurfaceId: 'original-bottom',
        getSendCompletionGeneration: () => 0,
        getComposerEditGeneration: () => 0
      })
    )
    const { snapshotEvent } =
      await import('./use-mobile-structured-agent-session-queued.test-fixture')
    act(() => {
      setMobileNativeChatDraftText('original-bottom', 'Bottom draft stays here.')
      state.listener?.(
        snapshotEvent({
          queuedMessages: [message, queuedDraft({ messageId: 'neighbor', position: 2 })],
          runningTurn: true
        })
      )
    })
    const style = (value: unknown): Record<string, unknown> => Object.assign({}, ...[value].flat())
    const queue = () => root().findByType(MobileNativeChatQueuedMessages)
    const scroll = () =>
      queue().find((node) => node.type === ScrollView && node.props.onContentSizeChange)
    const box = () => root().findByProps({ testID: 'queued-box' })
    const editor = () => root().findByType(MobileQueuedMessageComposer)
    const bottom = () => root().findByType(MobileNativeChatDraftComposer)
    expect(editor().findByType(MobileNativeChatComposer).props.attachments).toHaveLength(1)
    expect(queue().findAllByProps({ testID: 'queued-card-row' })).toHaveLength(2)
    // Every boundary down to the scrollport must yield to the keyboard/bottom siblings.
    for (const node of [box().parent!, box(), scroll().parent!, scroll()]) {
      expect(style(node.props.style)).toMatchObject({ flexShrink: 1, minHeight: 0 })
    }
    expect(style(scroll().props.style).maxHeight).toBeUndefined()
    expect(style(box().parent!.props.style).marginBottom).toBe(0)
    expect(style(box().props.style).paddingBottom).toBe(0)
    expect(queue().findAllByType(MobileNativeChatDraftComposer)).toHaveLength(0)
    const field = editor().findByType(TextInput)
    act(() => {
      field.props.onChangeText('/')
      field.props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } })
    })
    const menuScroll = root().findByType(MobileNativeChatComposerMenu).findByType(ScrollView)
    expect(style(menuScroll.props.style).maxHeight).toBe(300)
    expect(menuScroll.props.nestedScrollEnabled).toBe(true)
    expect(menuScroll.props.keyboardShouldPersistTaps).toBe('always')
    const scrollTo = vi.fn()
    scroll().props.ref.current = { scrollTo, flashScrollIndicators: vi.fn() }
    act(() => {
      scroll().props.onLayout({ nativeEvent: { layout: { height: 280 } } })
      scroll().props.onContentSizeChange(360, 800)
      editor().parent!.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 620 } }
      })
    })
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 0, animated: false })
    act(() => scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    await act(async () => button('$skill-5').props.onPress())
    expect(state.hook!.queued.editor?.text).toBe('$skill-5 ')
    expect(readMobileNativeChatDraftInputs(state.hook!.queued.editor!.scopeKey).skills).toEqual([
      { name: 'skill-5', path: '/skills/5/SKILL.md' }
    ])
    expect(editor().findByType(MobileNativeChatComposer).props.attachments).toHaveLength(1)
    expect(bottom().findByType(TextInput).props.value).toBe('Bottom draft stays here.')
    await act(async () => button('Cancel editing').props.onPress())
    expect(style(scroll().props.style).maxHeight).toBe(160)
    expect(style(box().parent!.props.style).marginBottom).toBeLessThan(0)
    expect(bottom().findByType(TextInput).props.value).toBe('Bottom draft stays here.')
    act(() => {
      bottom().findByType(TextInput).props.onChangeText('/')
      bottom()
        .findByType(TextInput)
        .props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } })
    })
    const ordinaryMenu = bottom().findByType(MobileNativeChatComposerMenu).findByType(ScrollView)
    expect(style(ordinaryMenu.props.style).maxHeight).toBe(300)
    expect(ordinaryMenu.props.nestedScrollEnabled).toBeFalsy()
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
    ).toBe(false)
  })
  it('hands back into the main captured Send path, keeps pending files, and restores a rejected complete draft', async () => {
    const { snapshotEvent, ok, fieldsOf } =
      await import('./use-mobile-structured-agent-session-queued.test-fixture')
    const scope = mobileNativeChatScopeKey('host', 'worktree', 'handoff')!
    const message = queuedDraft({
      messageId: 'pending-files',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review intent' }],
        skills: [{ name: 'review', path: '/edit/SKILL.md' }]
      }
    })
    function Bottom({ session }: { session: NonNullable<typeof state.hook> }) {
      const drafts = useMobileNativeChatDrafts({
        hostId: 'host',
        worktreeId: 'worktree',
        tabId: 'handoff',
        sessionId: SESSION_ID,
        messages: [],
        transcriptSettled: true
      })
      const bridge = useMobileStructuredNativeChatSendBridge({
        ...drafts,
        agent: 'codex',
        sendStructured: session.sendWithOutcome,
        onSendError: error
      })
      const text = useMobileNativeChatDraft(scope)
      const files = useMobileNativeChatFileAttachments({
        client,
        sessionId: SESSION_ID,
        scopeKey: scope,
        enabled: true,
        showToast: error
      })
      const images = useMobileNativeChatImageAttachments({
        client,
        agent: 'codex',
        activeHandleRef: { current: null },
        deviceTokenRef: { current: null },
        getActiveWorktreeConnectionId: async () => null,
        connState: 'connected',
        scopeKey: scope,
        enabled: true,
        structuredNativeChat: true,
        showToast: error,
        onSendError: error,
        baseSend: bridge.sendWithOutcome,
        readSeededLaunchDraft: () => null,
        files: files.files,
        onFilesSent: files.removeFiles
      })
      return createElement(MobileNativeChatComposer, {
        value: text,
        agent: 'codex',
        draftScopeKey: scope,
        onChangeText: drafts.setComposerText,
        onSend: images.sendNativeChat,
        sendSurfaceId: scope,
        getSendCompletionGeneration: () => 0,
        getComposerEditGeneration: drafts.getComposerEditGeneration,
        attachments: images.attachments,
        structured: {
          catalog: { reported: [], conversationCommands: [] },
          onSlashMenuOpen: () => {},
          files: files.files,
          onRemoveFile: () => {}
        }
      })
    }
    const { root, button, field } = await rows(
      message,
      'codex',
      SESSION_ID,
      { reported: [{ name: 'later', kind: 'skill', path: '/later/SKILL.md' }] },
      (hook) => createElement(Bottom, { session: hook }),
      scope
    )
    act(() => {
      field().props.onChangeText('$review intent then $la')
      field().props.onSelectionChange({ nativeEvent: { selection: { start: 23, end: 23 } } })
    })
    await act(async () => button('$later').props.onPress())
    act(() => {
      setMobileNativeChatDraftText(scope, '$prior occupied')
      updateMobileNativeChatDraftInputs(scope, () => ({
        images: [{ id: 'prior-image', path: '/prior.png', previewUri: 'file:///prior.png' }],
        files: [
          {
            id: 'prior-file',
            path: '/prior.txt',
            name: 'prior.txt',
            mime: 'text/plain',
            byteLength: 1
          }
        ],
        skills: [{ name: 'prior', path: '/prior/SKILL.md' }]
      }))
      updateMobileNativeChatDraftInputs(state.hook!.queued.editor!.scopeKey, (input) => ({
        ...input,
        images: [{ id: 'edit-image', path: '/added.png', previewUri: 'file:///added.png' }]
      }))
    })
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = () => {}
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    picker.pickFiles.mockImplementation(async function* () {
      yield { name: 'late.txt', mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
    })
    let rejected = false
    sendRequest.mockImplementation(async (method, params) => {
      if (method.endsWith('uploadStart')) {
        started()
        await held
        return ok({ uploadId: 'pending-upload' })
      }
      if (method.endsWith('uploadCommit')) {
        return ok({ path: '/late.txt', name: 'late.txt', byteLength: 1 })
      }
      if (method.endsWith('uploadChunk')) {
        return ok(null)
      }
      if (method === 'agentSession.send') {
        if (!rejected) {
          rejected = true
          return {
            id: 'send-refusal',
            ok: false,
            error: { code: 'unauthorized', message: 'Send refused before execution' }
          }
        }
        return mutationOk(structuredSendResultFixture('accepted'))
      }
      return readOrHoldReply(method, params)
    })
    const inline = root()
      .findByType(MobileQueuedMessageComposer)
      .findByType(MobileNativeChatComposer)
    await act(async () => {
      inline.props.structured.onAttachFiles()
      await start
    })
    const beforeBottom = root()
      .findAllByType(MobileNativeChatComposer)
      .find((node) => node.props.draftScopeKey === scope)!
    act(() => state.listener?.(snapshotEvent({ queuedMessages: [] })))
    expect(root().findByType(MobileNativeChatComposer)).toBe(beforeBottom)
    expect(state.hook!.queued.editor).toBeUndefined()
    const pressSend = () =>
      root()
        .findAll(
          (node) =>
            node.props.accessibilityLabel === 'Send message' &&
            typeof node.props.onPress === 'function'
        )[0]!
        .props.onPress()
    await act(async () => pressSend())
    expect(sendRequest.mock.calls.some(([method]) => method === 'agentSession.send')).toBe(false)
    await act(async () => {
      release()
      await vi.waitFor(() => expect(readMobileNativeChatDraftInputs(scope).pending ?? 0).toBe(0))
    })
    await act(async () => pressSend())
    expect(root().findByType(MobileNativeChatComposer)).toBe(beforeBottom)
    expect(root().findByType(TextInput).props.value).toBe(
      '$prior occupied\n\n$review intent then $later '
    )
    expect(readMobileNativeChatDraftInputs(scope).skills).toEqual([
      { name: 'prior', path: '/prior/SKILL.md' },
      { name: 'review', path: '/edit/SKILL.md' },
      { name: 'later', path: '/later/SKILL.md' }
    ])
    await act(async () => pressSend())
    const requests = sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
    expect(requests).toHaveLength(2)
    expect(requests[1]![1]).toMatchObject({ body: fieldsOf(requests[0]![1]).body })
    expect(requests[0]![1]).toMatchObject({
      body: {
        blocks: [
          {
            type: 'text',
            text: '$prior occupied\n\n$review intent then $later\n@/prior.txt @/late.txt'
          },
          { type: 'image-ref', path: '/prior.png' },
          { type: 'image-ref', path: '/added.png' }
        ],
        skills: [
          { name: 'prior', path: '/prior/SKILL.md' },
          { name: 'review', path: '/edit/SKILL.md' },
          { name: 'later', path: '/later/SKILL.md' }
        ]
      }
    })
    expect(readMobileNativeChatDraftInputs(scope).files).toEqual([])
    expect(readMobileNativeChatDraftInputs(scope).images).toEqual([])
  })

  it('refuses a stale control pick but saves a typed namesake literally when its menu is closed', async () => {
    const message = queuedDraft({ messageId: 'namesake' })
    const { root, button, field } = await rows(message, 'claude', SESSION_ID, {
      reported: [{ name: 'model', kind: 'skill', path: '/A/SKILL.md' }]
    })
    act(() => field().props.onChangeText('/'))
    act(() => field().props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } }))
    const stale = root().findByType(MobileNativeChatComposerMenu).props.onPick
    await act(async () => button('/model').props.onPress())
    const key = state.hook!.queued.editor!.scopeKey
    expect(readMobileNativeChatDraftInputs(key).skills).toHaveLength(1)
    act(() => stale({ kind: 'command', token: '/model', name: 'model', id: 'command:model' }))
    expect(error).toHaveBeenLastCalledWith("Commands can't be saved in a queued message.")
    expect(state.hook!.queued.editor!.text).toBe('/model ')
    act(() => field().props.onChangeText(''))
    act(() => field().props.onChangeText('/model literal'))
    expect(readMobileNativeChatDraftInputs(key).skills).toEqual([])
    act(() =>
      field().props.onSelectionChange({ nativeEvent: { selection: { start: 14, end: 14 } } })
    )
    expect(root().findAllByType(MobileNativeChatComposerMenu)).toHaveLength(0)
    await act(async () => button('Save edited message').props.onPress())
    expect(error).toHaveBeenCalledOnce()
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
    ).toHaveLength(1)
    expect(
      sendRequest.mock.calls.some(([method]) =>
        /(?:\.send$|conversationCommand|goal|resume|pty)/i.test(method)
      )
    ).toBe(false)
    expect(state.hook!.queued.editor).toBeUndefined()
  })

  it('an image-only attributed card reaches the actual inline composer and no-op Save retains its image and sender', async () => {
    const message = queuedDraft({
      messageId: 'photo-only',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', url: 'https://host/photo.png', alt: 'photo' }],
        from: { kind: 'agent', senders: [], orchestration: null }
      }
    })
    const { root, button } = await rows(message)
    expect(root().findByType(MobileNativeChatComposer).props.attachments).toHaveLength(1)
    await act(async () => button('Save edited message').props.onPress())
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
    ).toBe(false)
    expect(state.hook!.queued.cards[0]?.images).toEqual(message.body.blocks)
    expect(state.hook!.queued.cards[0]?.attribution).not.toBeNull()
    expect(state.bottomText).toBe('')
  })
  it('saves a scanned model skill picked through More and Edit without dispatching a host command', async () => {
    const options = new AcpStructuredOptions()
    options.adoptCommands([{ name: 'model', description: 'Choose the model' }])
    const reported = options.readCommands() ?? []
    expect(reported).toEqual([{ name: 'model', kind: 'command', description: 'Choose the model' }])
    const message = queuedDraft({
      messageId: 'scanned-model',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'seed' }] }
    })
    const host = queuedEditHost(SESSION_ID, message)
    try {
      const { root, button, field } = await rows(message, 'opencode2', SESSION_ID, {
        reported,
        discovery: {
          status: 'ready',
          skills: [
            {
              id: 'repo:model',
              name: 'model',
              description: 'Explain the domain model',
              providers: ['agent-skills'],
              sourceKind: 'repo',
              sourceLabel: 'Repo',
              rootPath: '/workspace/.agents/skills',
              directoryPath: '/workspace/.agents/skills/model',
              skillFilePath: '/workspace/.agents/skills/model/SKILL.md',
              installed: true,
              updatedAt: null
            }
          ]
        }
      })
      sendRequest.mockImplementation(async (method, params) =>
        method === 'agentSession.queuedMessageUpdate'
          ? mutationOk(host.update(QueuedMessageUpdateParams.parse(params)))
          : readOrHoldReply(method, params)
      )
      act(() => field().props.onChangeText('/'))
      act(() =>
        field().props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } })
      )
      const menu = root().findByType(MobileNativeChatComposerMenu)
      expect(menu.props.rows.filter((row: { token?: string }) => row.token === '/model')).toEqual([
        expect.objectContaining({
          kind: 'skill',
          id: 'skill:model',
          token: '/model',
          sources: [
            { sourceKind: 'repo', skillFilePath: '/workspace/.agents/skills/model/SKILL.md' }
          ]
        })
      ])
      expect(
        menu.props.rows.find((row: { token?: string }) => row.token === '/model')
      ).not.toHaveProperty('path')
      await act(async () => button('/model').props.onPress())
      expect(state.hook!.queued.editor?.text).toBe('/model ')
      expect(readMobileNativeChatDraftInputs(state.hook!.queued.editor!.scopeKey).skills).toEqual(
        []
      )
      expect(error.mock.calls).toEqual([])
      await act(async () => button('Save edited message').props.onPress())
      expect(
        sendRequest.mock.calls.some(([method]) =>
          /(?:\.send$|conversationCommand|goal|resume|pty|setOption)/i.test(method)
        )
      ).toBe(false)
      expect(error.mock.calls).toEqual([])
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).toHaveLength(1)
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(host.row!.body.blocks).toEqual([{ type: 'text', text: '/model' }])
      expect(host.row!.body.skills).toBeUndefined()
    } finally {
      host.leases.dispose()
    }
  })
})
