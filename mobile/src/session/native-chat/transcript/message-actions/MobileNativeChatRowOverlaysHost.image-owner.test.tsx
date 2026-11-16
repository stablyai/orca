import { useContext } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatRowOverlays
} from './mobile-native-chat-row-overlays'
import { stubRpcClient } from '../../../../transport/rpc/rpc-client-test-stub'

vi.mock('react-native', async () => ({
  ...(await import('../../../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
  Image: 'Image',
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({ X: 'X' }))
vi.mock('../../../../platform/haptics/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('./MobileNativeChatRewindDialog', () => ({ MobileNativeChatRewindDialog: () => null }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../../../../browser/link-open/MobileLinkActionSheet', () => ({
  MobileLinkActionSheet: 'LinkActionSheet'
}))
vi.mock('../../visual/MobileImageViewerActions', () => ({
  MobileImageViewerActions: 'ImageViewerActions'
}))

let overlays: MobileNativeChatRowOverlays | null = null
function Row(): null {
  overlays = useContext(MobileNativeChatRowOverlaysContext)
  return null
}
let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('keeps an image across reconnect but closes it on workspace or client replacement', () => {
  let generation = 0
  const first = { client: stubRpcClient({ getGeneration: () => generation }), worktreeId: 'w1' }
  const second = { client: stubRpcClient(), worktreeId: 'w1' }
  const render = (imageSource: typeof first) => (
    <MobileNativeChatRowOverlaysHost
      conversation={{ surfaceId: 'tab-a', sessionId: 's1' }}
      imageSource={imageSource}
      linkOpenMode="ask"
    >
      <Row />
    </MobileNativeChatRowOverlaysHost>
  )
  act(() => {
    renderer = create(render(first))
  })
  act(() => overlays?.openImage({ uri: 'data:image/png;base64,AA==', label: 'Host image' }))
  const images = () => renderer!.root.findAll((node) => String(node.type) === 'Modal')
  expect(images()).toHaveLength(1)
  generation++
  act(() => renderer!.update(render(first)))
  expect(images()).toHaveLength(1)
  act(() => renderer!.update(render({ ...first, worktreeId: 'w2' })))
  expect(images()).toHaveLength(0)
  act(() => renderer!.update(render(first)))
  expect(images()).toHaveLength(0)
  act(() => overlays?.openImage({ uri: 'data:image/png;base64,AA==', label: 'Host image' }))
  expect(images()).toHaveLength(1)
  act(() => renderer!.update(render(second)))
  expect(images()).toHaveLength(0)
  act(() => renderer!.update(render(first)))
  expect(images()).toHaveLength(0)
})
