import { createElement } from 'react'
import * as mobileLanguage from '../i18n/mobile-i18n'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES
} from '../../../src/shared/attachment-text-source'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../src/shared/mobile-bridge-frame-bytes'
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
  Animated: { View: 'View' },
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

it('updates translated phone controls without restarting the source and retires subscriptions on unmount', async () => {
  const text = '\ufeffraw\r\n🙂 exact bytes'
  serveAttachment(Buffer.from(text))
  const baseLive = subscriptions.live
  const route = attachmentRoute(path.replace('report.txt', 'orca-paste-35636.txt'))
  mobileLanguage.mobileI18n.addResourceBundle('fr', 'translation', {
    common: { back: 'Retour', copy: 'Copier' },
    chat: { textAttachmentPreview: { pastedText: 'Texte collé', attachmentPage: 'Page jointe' } }
  })
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route }))
  })
  const input = tree!.root.find((node) => String(node.type) === 'TextInput')
  const reads = mocks.send.mock.calls.length
  const notifications = subscriptions.notifications
  const live = subscriptions.live
  await act(async () => {
    await mobileLanguage.activateMobileUiLocale('fr')
  })
  expect(subscriptions.notifications - notifications).toBe(live)
  expect(tree!.root.find((node) => String(node.type) === 'TextInput')).toBe(input)
  expect(input.props.accessibilityLabel).toBe('Page jointe')
  expect(tree!.root.findAll((node) => String(node.type) === 'Text').map(textIn)).toContain(
    'Texte collé'
  )
  expect(mocks.send).toHaveBeenCalledTimes(reads)
  await act(async () => button('Copier').props.onPress())
  expect(mocks.write).toHaveBeenCalledWith(text)
  await act(async () => button('Retour').props.onPress())
  const afterBack = mocks.send.mock.calls.length
  await act(async () => button('Copier').props.onPress())
  expect(mocks.send).toHaveBeenCalledTimes(afterBack)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  act(() => tree!.unmount())
  tree = null
  expect(subscriptions.live).toBe(baseLive)
})

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

it('resets the actual phone scroll only after publication, including typed page then First', async () => {
  serveAttachment(Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6)))
  const calls = vi.spyOn(AttachmentTextSource.prototype, 'page')
  const input = () => tree!.root.find((node) => String(node.type) === 'TextInput')
  const resetPages: string[] = []
  const scrollTo = vi.fn(() => resetPages.push(input().props.value))
  try {
    await act(async () => {
      tree = create(createElement(MobileFilePreviewScreen, { route: attachmentRoute(path) }), {
        createNodeMock: (element) =>
          String(element.type) === 'ScrollView'
            ? { scrollTo }
            : String(element.type) === 'TextInput'
              ? { isFocused: () => false, blur: () => input().props.onBlur() }
              : null
      })
    })
    const edit = (value: string) => act(() => input().props.onChangeText(value))
    const before = calls.mock.calls.length
    edit('1')
    edit('12')
    expect(calls).toHaveBeenCalledTimes(before)
    expect(resetPages).toEqual(['1'])
    await act(async () => input().props.onBlur())
    expect(resetPages).toEqual(['1', '12'])
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false })
    const committed = calls.mock.calls.length
    await act(async () => input().props.onBlur())
    expect(calls).toHaveBeenCalledTimes(committed)
    expect(resetPages).toEqual(['1', '12'])
    edit('9')
    await act(async () => button('First').props.onPress())
    expect(calls.mock.calls.slice(committed)).toEqual([
      [8, 0],
      [0, 0]
    ])
    expect(resetPages).toEqual(['1', '12', '9', '1'])
  } finally {
    calls.mockRestore()
  }
})
