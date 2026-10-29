import type { NativeChatSkillDiscoverySnapshot } from '../../../src/shared/native-chat/input/native-chat-picker-items'
import { QueuedMessageUpdateParams } from '../../../src/shared/rpc-contract/structured-agent-session-queued-edit-params'
import { createElement, type ReactNode } from 'react'
import { setMobileNativeChatDraftText } from './native-chat/composer/mobile-native-chat-draft-store'
import {
  mobileNativeChatDraftDestination,
  captureMobileNativeChatTextDestination,
  readMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { act } from 'react-test-renderer'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AcpCommandOptionsFixtureModule,
  MobileQueuedEditHostFixtureModule
} from '../../../src/shared/mobile-queued-edit-host.test-fixture-contract'
import { mobileQueuedEditHarness, readOrHoldReply } from './mobile-queued-edit-hook.test-fixture'
import { TextInput } from 'react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import { MobileNativeChatQueuedMessages } from './native-chat/input/MobileNativeChatQueuedMessages'
import { MobileNativeChatComposer } from './native-chat/composer/MobileNativeChatComposer'
import { MobileQueuedMessageComposer } from './MobileQueuedMessageComposer'
import type { QueuedEditHostFixtureModule } from '../../../src/shared/queued-edit-host.test-fixture'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import {
  mutationOk,
  queuedDraft,
  SESSION_ID
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

let queuedEditHost: QueuedEditHostFixtureModule['queuedEditHost']
beforeAll(async () => {
  const fixtures = await vi.importActual<QueuedEditHostFixtureModule>(
    '../../../src/main/native-chat/agent-session-journal/queued-edit-host.test-fixture'
  )
  queuedEditHost = fixtures.queuedEditHost
})

const picker = vi.hoisted(() => ({ pickFiles: vi.fn(), pickImages: vi.fn() }))
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

const hostFixtures = await vi.importActual<MobileQueuedEditHostFixtureModule>(
  '../../../src/main/native-chat/agent-session-wire/mobile-queued-edit-host.test-fixture'
)
const { AcpStructuredOptions } = await vi.importActual<AcpCommandOptionsFixtureModule>(
  '../../../src/main/acp/acp-structured-options'
)

describe('real phone inline composer from More through picker pruning and host body', () => {
  const { state, Harness, mount, sendRequest, error, resolved } = mobileQueuedEditHarness()
  const profiles = [
    ['claude', 'model', '/model'],
    ['codex', 'review.v2', '$review.v2'],
    ['pi', 'skill:review', '/skill:review'],
    ['openclaude', 'review', '/review'],
    ['opencode', 'review', '/review'],
    ['opencode2', 'review', '/review'],
    ['grok', 'review', '/review']
  ] as const
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
    extra?: (hook: NonNullable<typeof state.hook>) => ReactNode
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
            skillDiscovery: catalog.discovery ?? {
              status: 'ready',
              skills: catalog.reported
                .filter((entry) => entry.kind === 'skill' && entry.path)
                .map((entry) => ({
                  id: entry.name,
                  name: entry.name,
                  description: null,
                  providers: ['agent-skills'],
                  sourceKind: 'repo',
                  sourceLabel: 'Repo',
                  rootPath: '/skills',
                  directoryPath: `/skills/${entry.name}`,
                  skillFilePath: entry.path ?? '',
                  installed: true,
                  updatedAt: null
                }))
            },
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
            composerScopeKey: 'original-bottom'
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
      root().find((node) => node.type === TextInput && node.props.multiline === true)
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
  it.each(profiles)(
    '%s preserves its actual offered %s shape through the wrapper and accepted body',
    async (agent, name, token) => {
      const message = queuedDraft({
        messageId: 'picked',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'seed' }] }
      })
      const host = queuedEditHost(SESSION_ID, message)
      let path = '/A/SKILL.md'
      let unknown = agent === 'claude'
      let desired = message.body
      const scanned = agent === 'opencode' || agent === 'opencode2'
      const options = new AcpStructuredOptions()
      options.adoptCommands([{ name, description: 'Review the prompt' }])
      const catalog: NonNullable<Parameters<typeof rows>[3]> = {
        reported: scanned ? (options.readCommands() ?? []) : [{ name, kind: 'skill', path }],
        ...(scanned
          ? {
              discovery: {
                status: 'ready',
                skills: [
                  {
                    id: 'repo:review',
                    name,
                    description: null,
                    providers: ['agent-skills'],
                    sourceKind: 'repo',
                    sourceLabel: 'Repo',
                    rootPath: '/skills',
                    directoryPath: '/skills/review',
                    skillFilePath: path,
                    installed: true,
                    updatedAt: null
                  }
                ]
              }
            }
          : {})
      }
      const { button, field, rerender } = await rows(message, agent, SESSION_ID, catalog)
      sendRequest.mockImplementation(async (method, params) => {
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        const fields = QueuedMessageUpdateParams.parse(params)
        const edited = queuedMessageWithEdit(host.row!.body, fields)
        if (!edited.ok) {
          throw new Error(edited.reason)
        }
        desired = edited.body
        if (unknown) {
          throw markRpcDeliveryUnknown(new Error('lost'))
        }
        return mutationOk(host.update(fields))
      })
      const pick = async () => {
        act(() => field().props.onChangeText('/'))
        act(() =>
          field().props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } })
        )
        await act(async () => button(token).props.onPress())
        expect(state.hook!.queued.editor?.text).toBe(`${token} `)
        expect(readMobileNativeChatDraftInputs(state.hook!.queued.editor!.scopeKey).skills).toEqual(
          scanned ? [] : [{ name, path }]
        )
      }
      await pick()
      await act(async () => button('Save edited message').props.onPress())
      if (unknown) {
        const first = desired
        path = '/B/SKILL.md'
        catalog.reported = [{ name, kind: 'skill', path }]
        await rerender()
        // Reopen menu after deleting: deletion retires A before picking B.
        act(() => field().props.onChangeText(''))
        await pick()
        act(() => field().props.onChangeText(`${token} suffix`))
        const { batchEvent } =
          await import('./use-mobile-structured-agent-session-queued.test-fixture')
        act(() => state.listener?.(batchEvent([{ ...message, body: first }])))
        expect(state.hook!.queued.editor?.text).toBe(`${token} suffix`)
        expect(resolved).not.toHaveBeenCalled()
        expect(state.bottomText).toBe('')
        host.update({
          messageId: 'picked',
          expectedBodyFingerprint: host.row!.fingerprint,
          text: token,
          images: [],
          skills: [{ name, path: '/A/SKILL.md' }]
        })
        unknown = false
        await act(async () => button('Save edited message').props.onPress())
      }
      expect(error.mock.calls).toEqual([])
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).not.toHaveLength(0)
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(host.row!.body.skills).toEqual(scanned ? undefined : [{ name, path }])
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).toHaveLength(agent === 'claude' ? 2 : 1)
      expect(
        sendRequest.mock.calls.some(([method]) =>
          /(?:\.send$|conversationCommand|goal|resume|pty)/i.test(method)
        )
      ).toBe(false)
      host.leases.dispose()
    }
  )
  it('keeps both saved files on clean Save and projects the phone picked list after an argument edit', async () => {
    const skills = [
      { name: 'review', path: '/A/SKILL.md' },
      { name: 'review', path: '/B/SKILL.md' }
    ]
    const message = queuedDraft({
      messageId: 'two-files',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review old' }],
        skills
      }
    })
    const host = queuedEditHost(SESSION_ID, message)
    try {
      const { button, field, open } = await rows(message)
      sendRequest.mockImplementation(async (method, params) =>
        method === 'agentSession.queuedMessageUpdate'
          ? mutationOk(host.update(QueuedMessageUpdateParams.parse(params)))
          : readOrHoldReply(method, params)
      )
      await act(async () => button('Save edited message').props.onPress())
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).toHaveLength(0)
      expect(host.row!.body.skills).toEqual(skills)
      await open()
      act(() => field().props.onChangeText('$review changed'))
      await act(async () => button('Save edited message').props.onPress())
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(host.row!.body.skills).toEqual(skills)
      expect(host.row!.body.blocks).toEqual([{ type: 'text', text: '$review changed' }])
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).toHaveLength(1)
    } finally {
      host.leases.dispose()
    }
  })

  it.each(['question', 'approval'] as const)(
    'automatic/mail More→Edit→Save persists user authorship, position and options across journal reopen under %s',
    async (kind) => {
      const { ok, snapshotEvent } =
        await import('./use-mobile-structured-agent-session-queued.test-fixture')
      const clock = vi.spyOn(Date, 'now').mockReturnValue(hostFixtures.now)
      const rig = await hostFixtures.createMobileQueuedEditHostFixture()
      try {
        await rig.start()
        const from = { kind: 'agent' as const, senders: [], orchestration: null }
        const before = await rig.insert({
          messageId: `mail-${kind}`,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'mail intent' }],
            sentAs: 'goal',
            from
          },
          options: { model: 'saved-model', effort: 'high' }
        })
        const beforeWire = await rig.published(before.messageId)
        const { button, field, open } = await rows(beforeWire, 'codex', rig.sessionId)
        act(() => state.hook!.queued.editor!.cancel())
        const pending = {
          options: [{ id: 'yes', label: 'Yes' }],
          resolution: {
            state: 'pending' as const,
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
        const prompt = snapshotEvent({
          queuedMessages: [beforeWire],
          items: [
            {
              itemId: 'prompt',
              revision: 1,
              sequence: 1,
              observedAt: 1,
              body:
                kind === 'question'
                  ? { kind, question: 'Pick', ...pending }
                  : { kind, title: 'Allow?', detail: null, ...pending }
            }
          ]
        })
        act(() =>
          state.listener?.({
            ...prompt,
            sessionId: rig.sessionId,
            page: { ...prompt.page, sessionId: rig.sessionId }
          })
        )
        await open()
        const hostResults: unknown[] = []
        sendRequest.mockImplementation(async (method, params) => {
          if (method === 'agentSession.queuedMessageEditHold') {
            return ok(await rig.request(method, params))
          }
          if (method !== 'agentSession.queuedMessageUpdate') {
            return readOrHoldReply(method, params)
          }
          const result = await rig.request(method, params)
          hostResults.push(result)
          return ok(result)
        })
        // Equal Save proves no durable sender mutation or update RPC.
        await act(async () => button('Save edited message').props.onPress())
        expect(rig.read(before.messageId)?.body.from).toEqual(from)
        expect(
          sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
        ).toBe(false)
        await open()
        act(() => field().props.onChangeText('user replacement'))
        await act(async () => button('Save edited message').props.onPress())
        expect(hostResults, JSON.stringify(hostResults)).toMatchObject([
          { ok: true, value: { status: 'updated' } }
        ])
        expect(error.mock.calls).toEqual([])
        expect(state.hook!.queued.editor).toBeUndefined()
        const accepted = rig.read(before.messageId)!
        expect(accepted).toMatchObject({
          position: before.position,
          options: before.options,
          body: { sentAs: 'goal', blocks: [{ type: 'text', text: 'user replacement' }] }
        })
        expect(accepted.body).not.toHaveProperty('from')
        await rig.restart()
        const reopened = rig.read(before.messageId)!
        expect(reopened).toEqual(accepted)
        const publication = snapshotEvent({
          queuedMessages: [await rig.published(reopened.messageId)]
        })
        act(() =>
          state.listener?.({
            ...publication,
            sessionId: rig.sessionId,
            page: { ...publication.page, sessionId: rig.sessionId }
          })
        )
        await open()
        expect(state.hook!.queued.editor?.text).toBe('user replacement')
        expect(state.hook!.queued.cards[0]?.attribution).toBeNull()
      } finally {
        await rig.dispose()
        clock.mockRestore()
      }
    },
    15000
  )

  it.each(['updated', 'unknown', 'refused', 'unknown-phase'] as const)(
    'real phone Cancel revokes pending/unknown Save before late %s and cannot mutate a new edit',
    async (mode) => {
      const { batchEvent, fieldsOf } =
        await import('./use-mobile-structured-agent-session-queued.test-fixture')
      const message = queuedDraft({ messageId: 'pending-cancel' })
      const other = queuedDraft({ messageId: 'new-edit', position: 2 })
      const host = queuedEditHost(SESSION_ID, message)
      const { button, field } = await rows(message)
      act(() => setMobileNativeChatDraftText('original-bottom', 'occupied'))
      act(() => field().props.onChangeText('B'))
      act(() => field().props.onFocus())
      const dictate = captureMobileNativeChatTextDestination()!.insert
      const oldScope = state.hook!.queued.editor!.scopeKey
      const destination = mobileNativeChatDraftDestination(oldScope)
      let release = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      let oldEditId = ''
      sendRequest.mockImplementation(async (method, params) => {
        if (
          method === 'agentSession.queuedMessageEditHold' &&
          fieldsOf(params).action === 'release'
        ) {
          oldEditId = String(fieldsOf(params).editId)
        }
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        const decision =
          mode === 'refused'
            ? { status: 'not-editable' as const, messageId: message.messageId }
            : host.update(QueuedMessageUpdateParams.parse(params))
        expect(decision.status).toBe(mode === 'refused' ? 'not-editable' : 'updated')
        await pending
        if (mode === 'unknown' || mode === 'unknown-phase') {
          throw markRpcDeliveryUnknown(new Error('lost'))
        }
        return mutationOk(decision)
      })
      let save!: Promise<void>
      act(() => {
        save = button('Save edited message').props.onPress()
      })
      expect(state.hook!.queued.editor?.saving).toBe(true)
      expect(field().props.editable).toBe(false)
      expect(button('Save edited message').props.disabled).toBe(true)
      expect(button('Cancel editing').props.disabled ?? false).toBe(false)
      if (mode === 'unknown-phase') {
        await act(async () => {
          release()
          await save
        })
        expect(state.hook!.queued.editor?.saving).toBe(false)
        expect(field().props.editable).toBe(true)
      }
      await act(async () => button('Cancel editing').props.onPress())
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(destination.active).toBe(false)
      expect(oldEditId).not.toBe('')
      expect(state.bottomText).toBe('occupied')
      act(() => state.listener?.(batchEvent([message, other])))
      await act(async () => {
        await state.hook!.queued.edit!(other.messageId)
      })
      act(() => field().props.onChangeText('fresh input'))
      const newScope = state.hook!.queued.editor!.scopeKey
      act(() => expect(dictate('late speech')).toBe(false))
      await act(async () => {
        release()
        await save
      })
      act(() => state.listener?.(batchEvent([{ ...message, body: host.row!.body }, other])))
      expect(state.hook!.queued.editor).toMatchObject({
        messageId: other.messageId,
        text: 'fresh input',
        scopeKey: newScope,
        saving: false
      })
      expect(state.bottomText).toBe('occupied')
      expect(readMobileNativeChatDraftInputs(oldScope)).toMatchObject({
        files: [],
        images: [],
        skills: []
      })
      expect(error).not.toHaveBeenCalled()
      expect(resolved).not.toHaveBeenCalled()
      expect(
        sendRequest.mock.calls.filter(
          ([method, params]) =>
            method === 'agentSession.queuedMessageEditHold' &&
            fieldsOf(params).action === 'release' &&
            fieldsOf(params).editId === oldEditId
        )
      ).toHaveLength(1)
      host.leases.dispose()
    }
  )

  it.each(['files', 'images'] as const)(
    'real %s upload Cancel revokes its captured destination while normal pending admission blocks Save',
    async (kind) => {
      const { ok } = await import('./use-mobile-structured-agent-session-queued.test-fixture')
      const message = queuedDraft({ messageId: `cancel-${kind}` })
      const { root, button } = await rows(message)
      act(() => setMobileNativeChatDraftText('original-bottom', 'occupied'))
      const scope = state.hook!.queued.editor!.scopeKey
      const destination = mobileNativeChatDraftDestination(scope)
      let release = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      let started = () => {}
      const start = new Promise<void>((resolve) => {
        started = resolve
      })
      picker.pickFiles.mockImplementation(async function* () {
        yield { name: 'late.txt', mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
        yield { name: 'never.txt', mime: 'text/plain', byteLength: 1, base64: 'Yg==' }
      })
      picker.pickImages.mockResolvedValue([
        { base64: 'YQ==', uri: 'file:///late.png' },
        { base64: 'Yg==', uri: 'file:///never.png' }
      ])
      const isStart = (method: string) =>
        method.endsWith('uploadStart') || method === 'clipboard.startImageUpload'
      sendRequest.mockImplementation(async (method, params) => {
        if (isStart(method)) {
          started()
          await pending
          return ok({ uploadId: 'held' })
        }
        if (method === 'clipboard.commitImageUpload') {
          return ok('/late.png')
        }
        if (method.endsWith('uploadCommit')) {
          return ok({ path: '/late.txt', name: 'late.txt', byteLength: 1 })
        }
        if (method.includes('uploadChunk') || method === 'clipboard.appendImageUploadChunk') {
          return ok(null)
        }
        return readOrHoldReply(method, params)
      })
      const inline = root()
        .findByType(MobileQueuedMessageComposer)
        .findByType(MobileNativeChatComposer)
      await act(async () => {
        if (kind === 'files') {
          inline.props.structured.onAttachFiles()
        } else {
          inline.props.onAttachImage()
        }
        await start
      })
      expect(readMobileNativeChatDraftInputs(scope).pending).toBe(1)
      expect(state.hook!.queued.editor!.canSave).toBe(false)
      expect(button('Save edited message').props.disabled).toBe(true)
      expect(button('Cancel editing').props.disabled ?? false).toBe(false)
      await act(async () => button('Cancel editing').props.onPress())
      expect(destination.active).toBe(false)
      expect(state.hook!.queued.editor).toBeUndefined()
      await act(async () => {
        release()
        await vi.waitFor(() =>
          expect(
            sendRequest.mock.calls.some(
              ([method]) =>
                method.endsWith('uploadCommit') || method === 'clipboard.commitImageUpload'
            )
          ).toBe(true)
        )
      })
      expect(sendRequest.mock.calls.filter(([method]) => isStart(method))).toHaveLength(1)
      expect(
        sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
      ).toBe(false)
      expect(readMobileNativeChatDraftInputs(scope)).toMatchObject({
        files: [],
        images: [],
        skills: []
      })
      expect(readMobileNativeChatDraftInputs('original-bottom')).toMatchObject({
        files: [],
        images: []
      })
      expect(state.bottomText).toBe('occupied')
      expect(error).not.toHaveBeenCalled()
    }
  )
})
