import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ImageReadArgs = [client: unknown, worktreeId: string, relativePath: string, content: string]

const seams = vi.hoisted(
  (): {
    client: { sendRequest: () => void }
    imageReads: ImageReadArgs[]
    imageSources: Record<string, string>
    markdownPreviewProps: Array<{
      imageSources?: Record<string, string>
      onOpenImage?: (rawSrc: string) => void
    }>
    routePush: (href: unknown) => void
    pushedRoutes: unknown[]
  } => ({
    client: { sendRequest: () => {} },
    imageReads: [],
    imageSources: {},
    markdownPreviewProps: [],
    routePush: (href: unknown) => {
      seams.pushedRoutes.push(href)
    },
    pushedRoutes: []
  })
)

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Save: 'Icon' }))
vi.mock('react-native-gesture-handler', () => {
  const chain: Record<string, unknown> = {}
  for (const method of ['numberOfTaps', 'onBegin', 'onEnd', 'onFinalize', 'onUpdate']) {
    chain[method] = () => chain
  }
  return {
    Gesture: { Pan: () => chain, Pinch: () => chain, Simultaneous: () => chain, Tap: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  useAnimatedStyle: () => ({}),
  useSharedValue: <T,>(initial: T) => ({ value: initial }),
  withSpring: (value: number) => value
}))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => {}, canGoBack: () => false, push: seams.routePush })
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({
  MobileFilePreviewSourceText: () => null
}))
vi.mock('./MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: (props: { imageSources?: Record<string, string> }) => {
    seams.markdownPreviewProps.push(props)
    return null
  }
}))
vi.mock('../transport/client-context', () => ({
  useForceReconnect: () => null,
  useHostClient: () => ({ client: seams.client, state: 'connected', clientId: null })
}))
vi.mock('./mobile-file-preview-request', () => ({
  loadMobileFilePreview: () =>
    Promise.resolve({
      status: 'ready',
      kind: 'markdown',
      content: '# Doc\n\n![shot](images/shot.png)',
      truncated: false,
      byteLength: 29
    }),
  previewError: (message: string) => ({ status: 'error', message, reconnect: false }),
  saveMobileTerminalArtifactPreview: () => Promise.resolve({ status: 'saved' })
}))
vi.mock('../session/markdown-relative-image-srcs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session/markdown-relative-image-srcs')>()),
  readMarkdownImageSources: (...args: ImageReadArgs) => {
    seams.imageReads.push(args)
    return Promise.resolve(seams.imageSources)
  }
}))

import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'

const WORKTREE_ROUTE = {
  ok: true,
  params: { hostId: 'host-a', worktreeId: 'wt-1', relativePath: 'docs/list.md' }
} as const

const ARTIFACT_ROUTE = {
  ok: true,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    source: 'terminalArtifact',
    absolutePath: '/tmp/orca/artifact.md',
    grantId: 'grant-1'
  }
} as const

describe('the file preview markdown image resolution', () => {
  let tree: ReactTestRenderer | null = null

  beforeEach(() => {
    seams.imageReads = []
    seams.imageSources = {}
    seams.markdownPreviewProps = []
    seams.pushedRoutes = []
  })

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  async function render(route: typeof WORKTREE_ROUTE | typeof ARTIFACT_ROUTE): Promise<void> {
    await act(async () => {
      tree = create(createElement(MobileFilePreviewScreen, { route }))
    })
    // Let the preview load, then the image-read effect, then its state settle.
    await act(async () => {})
  }

  it('reads a ready worktree markdown document and forwards the resolved sources', async () => {
    seams.imageSources = { 'images/shot.png': 'data:image/png;base64,AAA' }
    await render(WORKTREE_ROUTE)

    expect(seams.imageReads).toEqual([
      [seams.client, 'wt-1', 'docs/list.md', '# Doc\n\n![shot](images/shot.png)']
    ])
    expect(seams.markdownPreviewProps.at(-1)?.imageSources).toEqual({
      'images/shot.png': 'data:image/png;base64,AAA'
    })
  })

  it('never reads images for a terminal-artifact markdown document', async () => {
    await render(ARTIFACT_ROUTE)

    expect(seams.imageReads).toEqual([])
  })

  it('pushes a zoomable preview route for a tapped image, resolved against the document', async () => {
    seams.imageSources = { 'images/shot.png': 'data:image/png;base64,AAA' }
    await render(WORKTREE_ROUTE)

    const onOpenImage = seams.markdownPreviewProps.at(-1)?.onOpenImage
    expect(onOpenImage).toBeTypeOf('function')
    act(() => {
      onOpenImage!('images/shot.png')
    })

    expect(seams.pushedRoutes).toEqual([
      {
        pathname: '/h/[hostId]/files/preview/[worktreeId]',
        params: {
          hostId: 'host-a',
          worktreeId: 'wt-1',
          source: 'worktree',
          relativePath: 'docs/images/shot.png',
          name: 'shot.png'
        }
      }
    ])
  })

  it('ignores an image tap whose src climbs out of the worktree', async () => {
    await render(WORKTREE_ROUTE)

    const onOpenImage = seams.markdownPreviewProps.at(-1)?.onOpenImage
    expect(onOpenImage).toBeTypeOf('function')
    act(() => {
      onOpenImage!('../../../outside.png')
    })

    expect(seams.pushedRoutes).toEqual([])
  })

  it('ignores an image tap whose src is an external URL', async () => {
    await render(WORKTREE_ROUTE)

    const onOpenImage = seams.markdownPreviewProps.at(-1)?.onOpenImage
    expect(onOpenImage).toBeTypeOf('function')
    act(() => {
      onOpenImage!('https://example.com/shot.png')
    })

    expect(seams.pushedRoutes).toEqual([])
  })
})
