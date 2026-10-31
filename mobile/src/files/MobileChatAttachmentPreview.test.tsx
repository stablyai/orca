import { createElement, Profiler } from 'react'
import * as mobileLanguage from '../i18n/mobile-i18n'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES
} from '../../../src/shared/attachment-text-source'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../src/shared/mobile-bridge-frame-bytes'
import {
  forgetHostDescriptor,
  recordHostDescriptor,
  useHostDescriptor
} from '../transport/host-descriptor-store'
import type { RpcResponse } from '../transport/types'
import { useMobileFileTapHandlers } from '../session/use-mobile-file-tap-handlers'
import { MobileNativeChatComposerAttachments } from '../session/native-chat/composer/MobileNativeChatComposerAttachments'
import {
  normalizeMobileFilePreviewRouteParams,
  type MobileFilePreviewParamValue
} from './mobile-file-preview-route'
import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'

const subscriptions = vi.hoisted(() => ({ registered: 0, live: 0, notifications: 0, removed: 0 }))
vi.mock('../i18n/mobile-i18n', async (importOriginal) => {
  const original = await importOriginal<typeof mobileLanguage>()
  return {
    ...original,
    getMobileUiRevision: vi.fn(original.getMobileUiRevision),
    subscribeMobileUiLanguage: vi.fn((callback: () => void) => {
      subscriptions.registered += 1
      subscriptions.live += 1
      const unsubscribe = original.subscribeMobileUiLanguage(() => {
        subscriptions.notifications += 1
        callback()
      })
      return () => {
        subscriptions.live -= 1
        subscriptions.removed += 1
        unsubscribe()
      }
    })
  }
})
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  write: vi.fn(),
  send: vi.fn(),
  generation: 1,
  addBack: vi.fn(),
  removeBack: vi.fn()
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: {
    addEventListener: (...args: unknown[]) => {
      mocks.addBack(...args)
      return { remove: mocks.removeBack }
    }
  },
  Image: 'Image',
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Keyboard: { addListener: () => ({ remove() {} }), metrics: () => undefined },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 34 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 })
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Save: 'Icon',
  FileText: 'Icon',
  Image: 'Icon',
  X: 'Icon'
}))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ push: mocks.push, back: mocks.back })
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: mocks.write }) }))
vi.mock('../platform/haptics', () => ({ triggerSelection: vi.fn() }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({ MobileFileMarkdownPreview: () => null }))
vi.mock('./MobileFilePreviewEditableSource', () => ({
  MobileFilePreviewEditableSource: () => null
}))
vi.mock('./MobileFilePreviewSourceText', () => ({ MobileFilePreviewSourceText: () => null }))
vi.mock('../transport/host-client-hooks', () => ({ useForceReconnect: () => vi.fn() }))
const client = {
  sendRequest: (...args: unknown[]) => mocks.send(...args),
  getState: () => 'connected' as const,
  getLastConnectedAt: () => 1,
  getGeneration: () => mocks.generation
}
vi.mock('../transport/use-workspace-client', () => ({
  useWorkspaceClient: () => ({ client, state: 'connected' })
}))
const path = '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/report.txt'
let tree: ReactTestRenderer | null = null
const textIn = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textIn).join('')
const button = (label: string) =>
  tree!.root.find((node) => String(node.type) === 'Pressable' && textIn(node) === label)
afterEach(async () => {
  act(() => tree?.unmount())
  tree = null
  forgetHostDescriptor('other35636')
  await act(async () => {
    await mobileLanguage.activateMobileUiLocale('en')
  })
  mobileLanguage.mobileI18n.removeResourceBundle('fr', 'translation')
  vi.clearAllMocks()
})

function serveAttachment(bytes: Buffer) {
  mocks.send.mockImplementation(
    async (method: string, request?: { offset: number; length: number }): Promise<RpcResponse> => {
      if (method === 'status.get') {
        return {
          id: 's',
          ok: true,
          result: { capabilities: ['native-chat.text-attachment-read.v1'] }
        }
      }
      if (!request) {
        throw new Error('Missing range')
      }
      const chunk = bytes.subarray(request.offset, request.offset + request.length)
      return {
        id: 'r',
        ok: true,
        result: {
          snapshot: 'a'.repeat(64),
          size: bytes.length,
          bytesRead: chunk.length,
          contentBase64: chunk.toString('base64'),
          eof: request.offset + chunk.length === bytes.length
        }
      }
    }
  )
}

it('opens a committed phone card through the file-tap route into the shipping preview and copies the complete source', async () => {
  const text = `\ufefffirst\r\n${'🙂'.repeat(10_000)}last`
  const bytes = Buffer.from(text)
  serveAttachment(bytes)
  function Card() {
    const handlers = useMobileFileTapHandlers({
      client,
      hostId: 'owner',
      worktreeId: 'folder:work',
      worktreeName: 'Work',
      nativeChatSessionId: 's',
      structuredAttachments: true,
      activeHandleRef: { current: null },
      terminalCwdRef: { current: new Map() },
      openBrowser: vi.fn(),
      fetchSessionTabs: async () => {},
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'chat',
      getActiveSessionTabType: () => 'agent-session',
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      reportChatTapFailure: vi.fn()
    })
    return createElement(MobileNativeChatComposerAttachments, {
      images: [],
      files: [
        { id: 'file', name: 'report.txt', mime: 'text/plain', byteLength: bytes.length, path }
      ],
      onOpenFile: handlers.handleNativeChatFileTap
    })
  }
  await act(async () => {
    tree = create(createElement(Card))
  })
  expect(mocks.send).not.toHaveBeenCalled()
  const card = tree!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button'
  )
  act(() => card.props.onPress())
  expect(mocks.push).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        hostId: 'owner',
        absolutePath: path,
        source: 'chatAttachment'
      })
    })
  )
  const route = normalizeMobileFilePreviewRouteParams(mocks.push.mock.calls[0]![0].params)
  await act(async () => {
    tree!.update(createElement(MobileFilePreviewScreen, { route }))
  })
  expect(button('Copy').props.disabled).toBe(false)
  expect(button('Save').props.disabled).toBe(true)
  await act(async () => button('Copy').props.onPress())
  expect(mocks.write).toHaveBeenCalledWith(text)
  expect(
    mocks.send.mock.calls.some(([method]) => method === 'agentSessionAttachment.readTextChunk')
  ).toBe(true)
})

it('refuses escaped full Copy that exceeds the phone frame and never copies the page', async () => {
  const bytes = Buffer.from('\u0001'.repeat(120_000))
  serveAttachment(bytes)
  const route = normalizeMobileFilePreviewRouteParams({
    hostId: 'owner',
    worktreeId: 'work',
    source: 'chatAttachment',
    absolutePath: path
  })
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route }))
  })
  expect(button('Copy').props.disabled).toBe(false)
  await act(async () => button('Copy').props.onPress())
  expect(mocks.write).not.toHaveBeenCalled()
  expect(
    tree!.root
      .findAll((node) => node.props.accessibilityRole === 'alert')
      .map(textIn)
      .join('')
  ).toContain('Full Copy for this attachment needs the upcoming phone update')
  const reads = mocks.send.mock.calls.length
  mobileLanguage.mobileI18n.addResourceBundle('fr', 'translation', {
    chat: { textAttachmentPreview: { copyFrame: 'Copie complète après la mise à jour.' } }
  })
  await act(async () => {
    await mobileLanguage.activateMobileUiLocale('fr')
  })
  expect(
    tree!.root.findAll((node) => node.props.accessibilityRole === 'alert').map(textIn)
  ).toContain('Copie complète après la mise à jour.')
  expect(mocks.send).toHaveBeenCalledTimes(reads)
  expect(mocks.write).not.toHaveBeenCalled()
})

function attachmentRoute(absolutePath: MobileFilePreviewParamValue) {
  return normalizeMobileFilePreviewRouteParams({
    hostId: 'owner',
    worktreeId: 'work',
    source: 'chatAttachment',
    absolutePath
  })
}

it.each([1, 10])(
  'bounds real mobile locale publications at %i mounted preview routes and retires on Back until unmount',
  async (count) => {
    const text = '\ufeffraw\r\n🙂 exact bytes'
    const bytes = Buffer.from(text)
    serveAttachment(bytes)
    const commits = vi.fn()
    const publications: {
      delta: number
      notifications: number
      commits: number
      snapshots: number
    }[] = []
    const baseLive = subscriptions.live
    const route = attachmentRoute(path.replace('report.txt', 'orca-paste-35636.txt'))
    const composer = createElement(MobileNativeChatComposerAttachments, {
      images: [],
      files: [
        { id: 'ordinary', name: 'Pasted text', mime: 'text/plain', byteLength: bytes.length, path }
      ],
      onOpenFile: mocks.push
    })
    const descriptors: (string | null | undefined)[] = []
    function OtherHost() {
      const descriptor = useHostDescriptor('other35636')
      descriptors.push(descriptor?.machineName)
      return createElement('HostWitness', { machineName: descriptor?.machineName })
    }
    const ui = (open: boolean) =>
      createElement(
        'Routes',
        null,
        composer,
        createElement(OtherHost),
        open
          ? Array.from({ length: count }, (_, index) =>
              createElement(
                Profiler,
                { key: index, id: String(index), onRender: commits },
                createElement(MobileFilePreviewScreen, { route })
              )
            )
          : null
      )
    mobileLanguage.mobileI18n.addResourceBundle('fr', 'translation', {
      common: { back: 'Retour', copy: 'Copier', save: 'Enregistrer', retry: 'Réessayer' },
      chat: {
        textAttachmentPreview: {
          pastedText: 'Texte collé',
          first: 'Début',
          prev: 'Préc',
          next: 'Suivant',
          last: 'Fin',
          byteSize: '{{size}} octets',
          attachmentPage: 'Page jointe',
          saveUpdate: 'Enregistrer après la mise à jour.'
        }
      }
    })
    await act(async () => {
      tree = create(ui(false))
    })
    const closedLive = subscriptions.live
    expect(closedLive - baseLive).toBe(2)
    expect(mocks.send).not.toHaveBeenCalled()
    const registrations = subscriptions.registered
    await act(async () => {
      tree!.update(ui(true))
    })
    expect(subscriptions.live - closedLive).toBe(count * 2)
    expect(subscriptions.registered - registrations).toBe(count * 2)
    const inputs = tree!.root.findAll((node) => String(node.type) === 'TextInput')
    expect(inputs).toHaveLength(count)
    const reads = mocks.send.mock.calls.slice()
    const rendered = commits.mock.calls.length
    const notifications = subscriptions.notifications
    const revision = mobileLanguage.getMobileUiRevision()
    const descriptorRegistrations = subscriptions.registered
    const descriptorLive = subscriptions.live
    const witnessed = descriptors.length
    await act(async () => {
      recordHostDescriptor('other35636', { machineName: 'changed35636', platform: 'linux' })
    })
    const descriptorWitnessRenders = descriptors.length - witnessed
    expect(descriptorWitnessRenders).toBe(1)
    expect(descriptors.at(-1)).toBe('changed35636')
    expect(tree!.root.find((node) => String(node.type) === 'HostWitness').props.machineName).toBe(
      'changed35636'
    )
    expect(commits).toHaveBeenCalledTimes(rendered)
    expect(subscriptions.registered).toBe(descriptorRegistrations)
    expect(subscriptions.live).toBe(descriptorLive)
    expect(subscriptions.notifications).toBe(notifications)
    expect(mobileLanguage.getMobileUiRevision()).toBe(revision)
    expect(mocks.send.mock.calls).toEqual(reads)
    const activate = async () => {
      const before = mobileLanguage.getMobileUiRevision()
      const notified = subscriptions.notifications
      const renderedBefore = commits.mock.calls.length
      const snapshots = vi.mocked(mobileLanguage.getMobileUiRevision).mock.calls.length
      await act(async () => {
        await mobileLanguage.activateMobileUiLocale('fr')
      })
      const delta = mobileLanguage.getMobileUiRevision() - before
      expect(delta).toBe(1)
      expect(subscriptions.notifications - notified).toBe(subscriptions.live * delta)
      expect(commits.mock.calls.length - renderedBefore).toBe(count)
      expect(
        vi.mocked(mobileLanguage.getMobileUiRevision).mock.calls.length - snapshots
      ).toBeLessThanOrEqual(12 * subscriptions.live + 2)
      expect(mocks.send.mock.calls).toEqual(reads)
      publications.push({
        delta,
        notifications: subscriptions.notifications - notified,
        commits: commits.mock.calls.length - renderedBefore,
        snapshots: vi.mocked(mobileLanguage.getMobileUiRevision).mock.calls.length - snapshots
      })
    }
    await activate()
    expect(tree!.root.findAll((node) => String(node.type) === 'TextInput')).toEqual(inputs)
    expect(
      inputs.every(
        (input) => input.props.accessibilityLabel === 'Page jointe' && input.props.value === '1'
      )
    ).toBe(true)
    const buttons = (label: string) =>
      tree!.root.findAll((node) => String(node.type) === 'Pressable' && textIn(node) === label)
    expect(buttons('Copier')).toHaveLength(count)
    expect(buttons('Enregistrer').every((node) => node.props.disabled)).toBe(true)
    const visible = tree!.root.findAll((node) => String(node.type) === 'Text').map(textIn)
    expect(visible.filter((value) => value === 'Texte collé')).toHaveLength(count)
    expect(visible).toContain('Pasted text')
    expect(
      visible.filter((value) => value === `${bytes.length.toLocaleString('fr')} octets`)
    ).toHaveLength(count)
    expect(visible.filter((value) => value === 'Enregistrer après la mise à jour.')).toHaveLength(
      count
    )
    const beforeCatalog = mobileLanguage.getMobileUiRevision()
    const notifiedBeforeCatalog = subscriptions.notifications
    mobileLanguage.mobileI18n.addResource('fr', 'translation', 'common.copy', 'Tout copier')
    expect(mobileLanguage.getMobileUiRevision()).toBe(beforeCatalog)
    expect(subscriptions.notifications).toBe(notifiedBeforeCatalog)
    await activate()
    expect(buttons('Tout copier')).toHaveLength(count)
    await act(async () => buttons('Tout copier')[0]!.props.onPress())
    expect(mocks.write).toHaveBeenCalledWith(text)
    const afterCopy = mocks.send.mock.calls.length
    const liveBeforeBack = subscriptions.live
    await act(async () => {
      for (const node of buttons('Retour')) {
        node.props.onPress()
      }
    })
    expect(mocks.back).toHaveBeenCalledTimes(count)
    expect(subscriptions.live).toBe(liveBeforeBack)
    await act(async () => buttons('Tout copier')[0]!.props.onPress())
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(afterCopy)
    const removals = subscriptions.removed
    await act(async () => {
      tree!.update(ui(false))
    })
    expect(subscriptions.live).toBe(closedLive)
    expect(subscriptions.removed - removals).toBe(count * 2)
    const retiredCommits = commits.mock.calls.length
    const notified = subscriptions.notifications
    await act(async () => {
      await mobileLanguage.activateMobileUiLocale('fr')
    })
    expect(subscriptions.notifications - notified).toBe(closedLive)
    expect(commits).toHaveBeenCalledTimes(retiredCommits)
    expect(mocks.send).toHaveBeenCalledTimes(afterCopy)
    act(() => tree!.unmount())
    tree = null
    expect(subscriptions.live).toBe(baseLive)
    const retiredNotifications = subscriptions.notifications
    await act(async () => {
      await mobileLanguage.activateMobileUiLocale('en')
    })
    expect(subscriptions.notifications).toBe(retiredNotifications)
    const retiredWitness = descriptors.length
    act(() => {
      forgetHostDescriptor('other35636')
      recordHostDescriptor('other35636', { machineName: 'retired35636', platform: 'linux' })
      forgetHostDescriptor('other35636')
    })
    expect(descriptors).toHaveLength(retiredWitness)
    console.info(
      'PR35636 mobile locale population',
      JSON.stringify({
        count,
        closedListeners: closedLive - baseLive,
        openListeners: liveBeforeBack - closedLive,
        remainingListeners: subscriptions.live - baseLive,
        initialRpc: reads.length,
        publications,
        descriptorWitnessRenders
      })
    )
  }
)

it('renders translated missing, array and empty chat routes through the actual error surface', async () => {
  mobileLanguage.mobileI18n.addResourceBundle('fr', 'translation', {
    files: {
      filePreviewResponse: { loadFailed: 'Impossible de charger l’aperçu' },
      filePreviewScreen: { loadFailed: 'Impossible de charger l’aperçu' }
    }
  })
  await act(async () => {
    await mobileLanguage.activateMobileUiLocale('fr')
  })
  for (const absolutePath of [undefined, [], '']) {
    const route = attachmentRoute(absolutePath)
    expect(route.ok).toBe(false)
    await act(async () => {
      tree = create(createElement(MobileFilePreviewScreen, { route }))
    })
    expect(tree!.root.findAll((node) => String(node.type) === 'Text').map(textIn)).toContain(
      'Impossible de charger l’aperçu'
    )
    expect(mocks.send).not.toHaveBeenCalled()
    act(() => tree!.unmount())
    tree = null
  }
})

it('keeps the M5 invalid terminal document, Back, and registrations through locale activation and route reevaluation', async () => {
  const params = {
    hostId: 'h',
    worktreeId: 'w',
    source: 'terminalArtifact',
    absolutePath: '/tmp/a.txt'
  }
  const route = normalizeMobileFilePreviewRouteParams(params)
  expect(route).toEqual({ ok: false, message: 'Unable to load preview' })
  mobileLanguage.mobileI18n.addResourceBundle('fr', 'translation', {
    files: {
      filePreviewScreen: {
        loadFailed: 'Impossible de charger l’aperçu',
        backToFiles: 'Retour aux fichiers'
      },
      filePreviewResponse: { loadFailed: 'Impossible de charger l’aperçu' }
    }
  })
  const baseLive = subscriptions.live
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route }))
  })
  const document = tree!.root.find(
    (node) => typeof node.type === 'function' && node.type.name === 'MobileFilePreviewDocument'
  )
  const back = tree!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Back to files'
  )
  const registered = subscriptions.registered
  const live = subscriptions.live
  const removed = subscriptions.removed
  const backRegistrations = mocks.addBack.mock.calls.slice()
  expect(live).toBeGreaterThan(baseLive)
  expect(backRegistrations).toHaveLength(1)
  expect(mocks.removeBack).not.toHaveBeenCalled()
  expect(tree!.root.findAll((node) => String(node.type) === 'Text').map(textIn)).toContain(
    'Unable to load preview'
  )
  const notified = subscriptions.notifications
  const revision = mobileLanguage.getMobileUiRevision()
  await act(async () => {
    await mobileLanguage.activateMobileUiLocale('fr')
  })
  expect(mobileLanguage.getMobileUiRevision() - revision).toBe(1)
  expect(subscriptions.notifications - notified).toBe(live)
  expect(tree!.root.findByType(document.type)).toBe(document)
  expect(
    tree!.root.find(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Retour aux fichiers'
    )
  ).toBe(back)
  const reevaluated = normalizeMobileFilePreviewRouteParams({
    ...params,
    name: 'same refused35636'
  })
  expect(reevaluated).toEqual(route)
  await act(async () => {
    tree!.update(createElement(MobileFilePreviewScreen, { route: reevaluated }))
  })
  expect(tree!.root.findByType(document.type)).toBe(document)
  expect(
    tree!.root.find(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Retour aux fichiers'
    )
  ).toBe(back)
  expect(subscriptions.registered).toBe(registered)
  expect(subscriptions.live).toBe(live)
  expect(subscriptions.removed).toBe(removed)
  expect(mocks.addBack.mock.calls).toEqual(backRegistrations)
  expect(mocks.removeBack).not.toHaveBeenCalled()
  expect(tree!.root.findAll((node) => String(node.type) === 'Text').map(textIn)).toContain(
    'Impossible de charger l’aperçu'
  )
  act(() => back.props.onPress())
  expect(mocks.back).toHaveBeenCalledTimes(1)
  expect(mocks.send).not.toHaveBeenCalled()
  act(() => tree!.unmount())
  tree = null
  expect(subscriptions.live).toBe(baseLive)
  expect(subscriptions.removed - removed).toBe(live - baseLive)
  expect(mocks.removeBack).toHaveBeenCalledTimes(1)
})

it('translates retained reader and hook refusals without restarting the source, and preserves exact unknown errors', async () => {
  mobileLanguage.mobileI18n.addResourceBundle('fr', 'translation', {
    chat: {
      textAttachmentPreview: {
        hostUpdate: 'Mettre à jour cet hôte.',
        notText: 'Enregistrer pour ouvrir.',
        openFailed: 'Impossible d’ouvrir.'
      }
    }
  })
  const route = attachmentRoute(path)
  mocks.send.mockResolvedValue({ id: 's', ok: true, result: { capabilities: [] } })
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route }))
  })
  const reads = mocks.send.mock.calls.length
  await act(async () => {
    await mobileLanguage.activateMobileUiLocale('fr')
  })
  const alerts = () =>
    tree!.root.findAll((node) => node.props.accessibilityRole === 'alert').map(textIn)
  expect(alerts()).toContain('Mettre à jour cet hôte.')
  expect(mocks.send).toHaveBeenCalledTimes(reads)
  mocks.send.mockRejectedValueOnce(new TypeError('invalid encoding'))
  await act(async () => button('Retry').props.onPress())
  expect(alerts()).toContain('Enregistrer pour ouvrir.')
  mocks.send.mockRejectedValueOnce('external non-error')
  await act(async () => button('Retry').props.onPress())
  expect(alerts()).toContain('Impossible d’ouvrir.')
  mocks.send.mockRejectedValueOnce(new Error('External diagnostic unchanged'))
  await act(async () => button('Retry').props.onPress())
  expect(alerts()).toContain('External diagnostic unchanged')
})

it('keeps large full Copy and Save disabled with the same localized F2 explanation', async () => {
  serveAttachment(Buffer.from('a'.repeat(MOBILE_BRIDGE_MAX_FRAME_BYTES)))
  mobileLanguage.mobileI18n.addResourceBundle('fr', 'translation', {
    chat: {
      textAttachmentPreview: {
        fullCopySaveUpdate: 'Copie complète et enregistrement après la mise à jour.'
      }
    }
  })
  await act(async () => {
    await mobileLanguage.activateMobileUiLocale('fr')
  })
  const route = attachmentRoute(path)
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route }))
  })
  expect(button('Copy').props.disabled).toBe(true)
  expect(button('Save').props.disabled).toBe(true)
  expect(tree!.root.findAll((node) => String(node.type) === 'Text').map(textIn)).toContain(
    'Copie complète et enregistrement après la mise à jour.'
  )
  expect(mocks.write).not.toHaveBeenCalled()
})

it('commits mobile page drafts and resets only committed scroll presentation while retaining its owners', async () => {
  serveAttachment(Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6)))
  const normal = mocks.send.getMockImplementation()!
  const gate = Promise.withResolvers<void>()
  const pageCalls = vi.spyOn(AttachmentTextSource.prototype, 'page')
  const scrollTo = vi.fn()
  const offsets: number[] = []
  let held = false
  mocks.send.mockImplementation(
    async (method: string, request?: { offset: number; length: number }) => {
      if (method === 'agentSessionAttachment.readTextChunk' && request) {
        offsets.push(request.offset)
        if (
          held &&
          (request.offset === 0 || request.offset === 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3)
        ) {
          await gate.promise
        }
      }
      return normal(method, request)
    }
  )
  const route = attachmentRoute(path)
  const ui = () => createElement(MobileFilePreviewScreen, { route })
  const input = () => tree!.root.find((node) => String(node.type) === 'TextInput')
  const scroll = () => tree!.root.find((node) => String(node.type) === 'ScrollView')
  const edit = (value: string) => act(() => input().props.onChangeText(value))
  const commit = async () => {
    await act(async () => {
      input().props.onBlur()
    })
  }
  try {
    await act(async () => {
      tree = create(ui(), {
        createNodeMock: (element) =>
          String(element.type) === 'ScrollView'
            ? { scrollTo }
            : String(element.type) === 'TextInput'
              ? { isFocused: () => false, blur: () => input().props.onBlur() }
              : null
      })
    })
    const inputNode = input()
    const scrollNode = scroll()
    const owner = pageCalls.mock.contexts.at(-1)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    for (const page of ['3', '5']) {
      edit(page)
      await commit()
      expect(input().props.value).toBe(page)
    }
    expect(pageCalls.mock.contexts.at(-1)).toBe(owner)
    expect(scrollTo).toHaveBeenCalledTimes(3)
    const before = offsets.slice()
    held = true
    edit('1')
    await act(async () => {})
    expect(offsets).toEqual(before)
    expect(input().props.value).toBe('1')
    expect(input().props.editable).toBe(true)
    edit('12')
    expect(offsets).toEqual(before)
    expect(input().props.onSubmitEditing).toBeUndefined()
    await commit()
    expect(offsets).toEqual([...before, 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3])
    expect(input().props.editable).toBe(false)
    expect(button('Next').props.disabled).toBe(true)
    expect(button('First').props.disabled).toBe(true)
    expect(scrollTo).toHaveBeenCalledTimes(3)
    expect(scroll()).toBe(scrollNode)
    expect(textIn(scroll())).toBe('a'.repeat(256))
    const pendingCalls = pageCalls.mock.calls.length
    await commit()
    expect(pageCalls).toHaveBeenCalledTimes(pendingCalls)
    await act(async () => {
      held = false
      gate.resolve()
    })
    expect(input().props.value).toBe('12')
    expect(scrollTo).toHaveBeenCalledTimes(4)
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false })
    const committedCalls = pageCalls.mock.calls.length
    for (const invalid of ['', '0', '13', '1.5', 'bad']) {
      edit(invalid)
      expect(input().props.value).toBe(invalid)
      await commit()
      expect(input().props.value).toBe('12')
    }
    await commit()
    expect(pageCalls).toHaveBeenCalledTimes(committedCalls)
    expect(scrollTo).toHaveBeenCalledTimes(4)
    await act(async () => button('Next').props.onPress())
    expect(scrollTo).toHaveBeenCalledTimes(5)
    await commit()
    expect(scrollTo).toHaveBeenCalledTimes(5)
    edit('')
    edit('12')
    await commit()
    expect(scrollTo).toHaveBeenCalledTimes(6)
    expect(pageCalls).toHaveBeenCalledTimes(committedCalls + 2)
    expect(pageCalls.mock.contexts.at(-1)).toBe(owner)
    const reads = offsets.slice()
    await act(async () => {
      await mobileLanguage.activateMobileUiLocale('en')
    })
    await act(async () => {
      tree!.update(ui())
    })
    expect(input()).toBe(inputNode)
    expect(scroll()).toBe(scrollNode)
    expect(offsets).toEqual(reads)
    expect(scrollTo).toHaveBeenCalledTimes(6)
    edit('9')
    await act(async () => button('First').props.onPress())
    expect(input().props.value).toBe('1')
    expect(scrollTo).toHaveBeenCalledTimes(7)
    edit('8')
    await act(async () => button('Retry').props.onPress())
    expect(input().props.value).toBe('1')
    expect(pageCalls.mock.contexts.at(-1)).not.toBe(owner)
    expect(scrollTo).toHaveBeenCalledTimes(8)
    const retriedOwner = pageCalls.mock.contexts.at(-1)
    edit('7')
    await act(async () => {
      mocks.generation += 1
      tree!.update(ui())
    })
    expect(input().props.value).toBe('1')
    expect(pageCalls.mock.contexts.at(-1)).not.toBe(retriedOwner)
    expect(scroll()).toBe(scrollNode)
    expect(scrollTo).toHaveBeenCalledTimes(9)
    console.info(
      'PR35636 mobile pager presentation',
      JSON.stringify({
        offsets,
        pageCalls: pageCalls.mock.calls.length,
        scrollResets: scrollTo.mock.calls.length
      })
    )
  } finally {
    gate.resolve()
    pageCalls.mockRestore()
  }
})
